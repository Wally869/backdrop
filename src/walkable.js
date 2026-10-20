// Walkable area: polygon with holes on the ground plane, point tests and path planning. All in metres, [x, z].

export function pointInPolygon(x, z, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i], [xj, zj] = poly[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

export class Walkable {
  constructor({ outer, holes }, cornerMargin = 0.15) {
    this.outer = outer;
    this.holes = holes;
    // Hole corners pushed outward from the hole centroid: the nodes of the visibility graph.
    this.corners = [];
    for (const h of holes) {
      const cx = h.reduce((s, p) => s + p[0], 0) / h.length;
      const cz = h.reduce((s, p) => s + p[1], 0) / h.length;
      for (const [x, z] of h) {
        const dx = x - cx, dz = z - cz, l = Math.hypot(dx, dz);
        this.corners.push([x + (dx / l) * cornerMargin, z + (dz / l) * cornerMargin]);
      }
    }
    this.corners = this.corners.filter(([x, z]) => this.contains(x, z));
  }

  contains(x, z) {
    return pointInPolygon(x, z, this.outer) && !this.holes.some((h) => pointInPolygon(x, z, h));
  }

  // The segment stays inside the area (checked by sampling every 4 cm).
  segmentFree(a, b) {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const n = Math.max(1, Math.ceil(len / 0.04));
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      if (!this.contains(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)) return false;
    }
    return true;
  }

  // Waypoints from start to goal (both included), or null when no path exists.
  findPath(start, goal) {
    if (this.segmentFree(start, goal)) return [start, goal];
    const nodes = [start, goal, ...this.corners];
    const dist = nodes.map(() => Infinity);
    const prev = nodes.map(() => -1);
    const done = nodes.map(() => false);
    dist[0] = 0;
    for (;;) {
      let u = -1;
      for (let i = 0; i < nodes.length; i++) if (!done[i] && dist[i] < Infinity && (u < 0 || dist[i] < dist[u])) u = i;
      if (u < 0) return null;
      if (u === 1) break;
      done[u] = true;
      for (let v = 0; v < nodes.length; v++) {
        if (done[v] || !this.segmentFree(nodes[u], nodes[v])) continue;
        const d = dist[u] + Math.hypot(nodes[u][0] - nodes[v][0], nodes[u][1] - nodes[v][1]);
        if (d < dist[v]) { dist[v] = d; prev[v] = u; }
      }
    }
    const path = [];
    for (let i = 1; i >= 0; i = prev[i]) path.unshift(nodes[i]);
    return path;
  }
}
