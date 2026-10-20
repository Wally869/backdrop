import { pointInPolygon } from './walkable.js';

// Height model of a map, from the scene JSON `walkable.surfaces` (metres, [x, z] in plan). No surfaces = y 0 everywhere
// (the format default). A flat surface has a height y. A stairs surface has a body height that ramps from y0 at the
// `bottom` edge to y1 at the `top` edge (distance along the stair direction, perpendicular to `bottom`), and a tread
// height for a foot: y0 + rise * (index + 1), index = floor(distance / run) clamped to [0, steps - 1]; below the first
// nosing (distance < 0) a foot stands at y0.

function prepare(s) {
  const out = { name: s.name, polygon: s.polygon, y: s.y, stairs: null };
  if (s.stairs) {
    const st = s.stairs;
    const mid = (e) => [(e[0][0] + e[1][0]) / 2, (e[0][1] + e[1][1]) / 2];
    const B = mid(st.bottom), T = mid(st.top);
    const ex = st.bottom[1][0] - st.bottom[0][0], ez = st.bottom[1][1] - st.bottom[0][1];
    const l = Math.hypot(ex, ez);
    let nx = -ez / l, nz = ex / l;
    if ((T[0] - B[0]) * nx + (T[1] - B[1]) * nz < 0) { nx = -nx; nz = -nz; }
    out.stairs = { ...st, B, nx, nz, length: (T[0] - B[0]) * nx + (T[1] - B[1]) * nz };
  }
  return out;
}

function edgeDistance(x, z, poly) {
  let best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [ax, az] = poly[j], [bx, bz] = poly[i];
    const dx = bx - ax, dz = bz - az;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz)));
    best = Math.min(best, Math.hypot(x - ax - t * dx, z - az - t * dz));
  }
  return best;
}

export class Surfaces {
  constructor(list) {
    this.list = (list || []).map(prepare);
    this.maxY = Math.max(0, ...this.list.map((s) => (s.stairs ? s.stairs.y1 : s.y)));
  }

  // The surface containing the point; on a seam or just outside, the nearest one (numeric tolerance of the polygons).
  find(x, z) {
    let best = null, bd = Infinity;
    for (const s of this.list) {
      if (pointInPolygon(x, z, s.polygon)) return s;
      const d = edgeDistance(x, z, s.polygon);
      if (d < bd) { bd = d; best = s; }
    }
    return best;
  }

  // Distance along the stair direction from the bottom edge (m); negative below the first nosing.
  stairDistance(s, x, z) {
    const st = s.stairs;
    return (x - st.B[0]) * st.nx + (z - st.B[1]) * st.nz;
  }

  // Height of the body (character root) at a plan point.
  heightAt(x, z) {
    return this.heightOn(this.find(x, z), x, z);
  }

  // Body height on a given surface (extended past its polygon).
  heightOn(s, x, z) {
    if (!s) return 0;
    if (!s.stairs) return s.y;
    const st = s.stairs;
    const k = Math.max(0, Math.min(1, this.stairDistance(s, x, z) / st.length));
    return st.y0 + (st.y1 - st.y0) * k;
  }

  // Height of the floor under a foot at a plan point.
  treadAt(x, z) {
    const s = this.find(x, z);
    if (!s) return 0;
    if (!s.stairs) return s.y;
    const st = s.stairs;
    const d = this.stairDistance(s, x, z);
    if (d < 0) return st.y0;
    const idx = Math.max(0, Math.min(st.steps - 1, Math.floor(d / st.run)));
    return st.y0 + st.rise * (idx + 1);
  }

  isStairs(x, z) {
    const s = this.find(x, z);
    return !!(s && s.stairs);
  }
}
