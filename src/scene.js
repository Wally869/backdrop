import * as THREE from 'three';
import { buildCamera } from './camera.js';
import { Walkable } from './walkable.js';
import { Surfaces } from './surfaces.js';

export const PROXY_ORDER = -1; // proxies draw before the character (renderOrder 1)
const PROXY_SHADOW_ORDER = 2; // shadow twins of the proxies draw after the character (transparent pass)
const SHADOW_COLOR = 0x2c2f66; // toward the painted blue-violet shadows
const SHADOW_OPACITY = 0.42;

// Drawing-buffer size in pixels, shared by all masked proxy materials (updated by main.js on resize).
export const screenSize = { value: new THREE.Vector2(1, 1) };

// Depth-only material. With a mask texture (white = solid) it discards fragments where the mask is black; the mask is
// the plate image, so it is sampled in screen space: uv = gl_FragCoord.xy / drawing-buffer size, y flipped.
function addMask(mat, maskTex, key) {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uMask = { value: maskTex };
    shader.uniforms.uScreen = screenSize;
    shader.fragmentShader = shader.fragmentShader.replace('void main() {',
      'uniform sampler2D uMask;\nuniform vec2 uScreen;\nvoid main() {\n  if (texture2D(uMask, vec2(gl_FragCoord.x, uScreen.y - gl_FragCoord.y) / uScreen).r < 0.5) discard;');
  };
  mat.customProgramCacheKey = () => key;
}

function proxyMaterial(maskTex) {
  const mat = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: true });
  if (maskTex) addMask(mat, maskTex, 'proxy-mask');
  return mat;
}

// Shadow twin of a proxy: same geometry, drawn after the character with the depth test on and no depth write, pulled
// toward the camera by the polygon offset so it passes the depth test against its depth-only twin. Same mask.
function proxyShadowMaterial(maskTex) {
  const mat = new THREE.ShadowMaterial({
    color: SHADOW_COLOR, opacity: SHADOW_OPACITY, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
  });
  if (maskTex) addMask(mat, maskTex, 'proxy-shadow-mask');
  return mat;
}

async function loadMask(file, base) {
  const tex = await new THREE.TextureLoader().loadAsync(base + file);
  tex.flipY = false; // row 0 of the image is the top of the screen
  tex.colorSpace = THREE.NoColorSpace;
  tex.generateMipmaps = false;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  return tex;
}

export async function loadScene(url) {
  const data = await (await fetch(url)).json();
  const base = url.slice(0, url.lastIndexOf('/') + 1);
  const masks = {};
  for (const f of new Set(data.proxies.map((p) => p.mask).filter(Boolean))) masks[f] = await loadMask(f, base);
  const camera = buildCamera(data);
  const scene = new THREE.Scene();
  const walkable = new Walkable(data.walkable);
  const surfaces = new Surfaces(data.walkable.surfaces);

  // Invisible depth-only proxies: they hide the character where the painting has objects in front of it.
  const proxyMeshes = [];
  const benchMeshes = [];
  const proxyGroup = new THREE.Group();
  scene.add(proxyGroup);
  for (const p of data.proxies) {
    if (p.name === 'floor') continue; // the ground is the shadow plane below
    const geo = p.type === 'box'
      ? new THREE.BoxGeometry(...p.size)
      : new THREE.CylinderGeometry(p.radius, p.radius, p.height, 16);
    const mat = proxyMaterial(p.mask ? masks[p.mask] : null);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(...p.center);
    mesh.rotation.y = p.rotationY;
    mesh.renderOrder = PROXY_ORDER;
    mesh.name = p.name;
    proxyGroup.add(mesh);
    proxyMeshes.push(mesh);
    // Receives the character's shadow over the painting (see proxyShadowMaterial).
    const shadow = new THREE.Mesh(geo, proxyShadowMaterial(p.mask ? masks[p.mask] : null));
    shadow.position.copy(mesh.position);
    shadow.rotation.copy(mesh.rotation);
    shadow.receiveShadow = true;
    shadow.renderOrder = PROXY_SHADOW_ORDER;
    shadow.name = `${p.name}_shadow`;
    proxyGroup.add(shadow);
    if (p.name.startsWith('bench')) benchMeshes.push(mesh);
  }

  // Ground: only receives the character's shadow.
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(200, 200),
    new THREE.ShadowMaterial({ color: SHADOW_COLOR, opacity: SHADOW_OPACITY, depthWrite: false }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  floor.renderOrder = 0;
  scene.add(floor);

  // Sun, shadow camera fitted to the walkable area (plus character height).
  const sun = new THREE.DirectionalLight(0xfff0dc, 2.6);
  const dir = new THREE.Vector3(...data.sun.direction).normalize();
  const xs = data.walkable.outer.map((q) => q[0]), zs = data.walkable.outer.map((q) => q[1]);
  const center = new THREE.Vector3((Math.min(...xs) + Math.max(...xs)) / 2, 0, (Math.min(...zs) + Math.max(...zs)) / 2);
  sun.position.copy(center).addScaledVector(dir, 60);
  sun.target.position.copy(center);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.02; // m; the character is the only caster, so this only keeps the shadow edge clean on slanted faces
  scene.add(sun, sun.target);
  sun.updateMatrixWorld(true);
  sun.target.updateMatrixWorld(true);
  const sc = sun.shadow.camera;
  sc.position.copy(sun.position);
  sc.lookAt(sun.target.position);
  sc.updateMatrixWorld(true);
  const inv = sc.matrixWorldInverse.copy(sc.matrixWorld).invert();
  const box = new THREE.Box3();
  for (const x of [Math.min(...xs), Math.max(...xs)]) for (const z of [Math.min(...zs), Math.max(...zs)]) for (const y of [0, surfaces.maxY + 1.5]) {
    box.expandByPoint(new THREE.Vector3(x, y, z).applyMatrix4(inv));
  }
  sc.left = box.min.x; sc.right = box.max.x; sc.bottom = box.min.y; sc.top = box.max.y;
  sc.near = Math.max(0.1, -box.max.z - 1); sc.far = -box.min.z + 1;
  sc.updateProjectionMatrix();

  scene.add(new THREE.HemisphereLight(0xbcd6ff, 0xb9a995, 1.3));

  const marker = (data.markers || []).find((m) => m.name === 'bench_sit') || null;
  const debug = buildDebug(data, proxyMeshes, marker, surfaces);
  scene.add(debug);

  // Frees the GPU resources of this map (geometries, materials, mask textures, shadow map). The character is not
  // owned by the map: remove it from the scene before calling this.
  function dispose() {
    scene.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) for (const m of [].concat(o.material)) m.dispose();
      if (o.isLight && o.shadow) o.shadow.dispose();
    });
    for (const tex of Object.values(masks)) tex.dispose();
    scene.clear();
  }

  return {
    data, scene, camera, walkable, surfaces, floor, benchMeshes, marker, debug, dispose,
    exits: data.exits || [], arrivals: data.arrivals || [], characterHeight: data.characterHeight,
  };
}

// Height colour: blue at y = 0 to red at the highest surface.
function heightColor(y, maxY) {
  return new THREE.Color().setHSL(0.66 * (1 - (maxY > 0 ? Math.min(1, y / maxY) : 0)), 1, 0.5);
}

// Surfaces filled and coloured by height (the stairs ramp is shaded), stairs treads as yellow lines at their heights.
function addSurfaces(g, surfaces) {
  if (!surfaces.list.length) return;
  const fill = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.35, depthTest: false, side: THREE.DoubleSide });
  const yellow = new THREE.LineBasicMaterial({ color: 0xffff00, depthTest: false });
  for (const s of surfaces.list) {
    const contour = s.polygon.map(([x, z]) => new THREE.Vector2(x, z));
    const tris = THREE.ShapeUtils.triangulateShape(contour, []);
    const pos = [], col = [];
    for (const [x, z] of s.polygon) {
      const y = surfaces.heightOn(s, x, z);
      pos.push(x, y + 0.005, z);
      col.push(...heightColor(y, surfaces.maxY).toArray());
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.setIndex(tris.flat());
    const m = new THREE.Mesh(geo, fill);
    m.renderOrder = 8;
    g.add(m);
    if (!s.stairs) continue;
    const st = s.stairs;
    const [b0, b1] = st.bottom;
    const pts = [];
    for (let i = 0; i < st.steps; i++) {
      const d = i * st.run, y = st.y0 + st.rise * (i + 1);
      pts.push(new THREE.Vector3(b0[0] + st.nx * d, y, b0[1] + st.nz * d), new THREE.Vector3(b1[0] + st.nx * d, y, b1[1] + st.nz * d));
    }
    const lines = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), yellow);
    lines.renderOrder = 12;
    g.add(lines);
  }
}

function buildDebug(data, proxyMeshes, marker, surfaces) {
  const g = new THREE.Group();
  g.visible = false;
  addSurfaces(g, surfaces);
  const red = new THREE.MeshBasicMaterial({ color: 0xff2020, wireframe: true, depthTest: false });
  for (const m of proxyMeshes) {
    const w = new THREE.Mesh(m.geometry, red);
    w.position.copy(m.position); w.rotation.copy(m.rotation); w.renderOrder = 10;
    g.add(w);
  }
  const green = new THREE.LineBasicMaterial({ color: 0x20ff20, depthTest: false });
  const ring = (poly) => {
    const pts = [...poly, poly[0]].map(([x, z]) => new THREE.Vector3(x, 0.01, z));
    const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), green);
    l.renderOrder = 10;
    return l;
  };
  g.add(ring(data.walkable.outer));
  for (const h of data.walkable.holes) g.add(ring(h));
  const xs = data.walkable.outer.map((q) => q[0]), zs = data.walkable.outer.map((q) => q[1]);
  const gp = [];
  for (let x = Math.ceil(Math.min(...xs)); x <= Math.max(...xs); x++) gp.push(new THREE.Vector3(x, 0.01, Math.min(...zs)), new THREE.Vector3(x, 0.01, Math.max(...zs)));
  for (let z = Math.ceil(Math.min(...zs)); z <= Math.max(...zs); z++) gp.push(new THREE.Vector3(Math.min(...xs), 0.01, z), new THREE.Vector3(Math.max(...xs), 0.01, z));
  const grid = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(gp), new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.45, depthTest: false }));
  grid.renderOrder = 9;
  g.add(grid);
  const point = (color, p, facingY) => {
    const mat = new THREE.MeshBasicMaterial({ color, depthTest: false });
    const ball = new THREE.Mesh(new THREE.SphereGeometry(0.06, 12, 8), mat);
    ball.position.set(...p); ball.renderOrder = 11;
    const face = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(...p), new THREE.Vector3(p[0] + 0.5 * Math.sin(facingY), p[1], p[2] + 0.5 * Math.cos(facingY))]),
      new THREE.LineBasicMaterial({ color, depthTest: false }),
    );
    face.renderOrder = 11;
    g.add(ball, face);
  };
  if (marker) point(0xffff00, marker.position, marker.facingY);
  // exit zones (blue) and arrival points (cyan) when the map has them
  const blue = new THREE.LineBasicMaterial({ color: 0x2080ff, depthTest: false });
  for (const e of data.exits || []) {
    const pts = [...e.zone, e.zone[0]].map(([x, z]) => new THREE.Vector3(x, 0.02, z));
    const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), blue);
    l.renderOrder = 10;
    g.add(l);
  }
  for (const a of data.arrivals || []) point(0x00e0ff, [a.position[0], 0.02, a.position[1]], a.facingY);
  return g;
}
