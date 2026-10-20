import * as THREE from "three";
import { loadScene, screenSize } from "./scene.js";
import { loadCharacter } from "./character.js";
import { Controller } from "./controller.js";
import { pointInPolygon } from "./walkable.js";
import "@fontsource-variable/inter"; // controls popup
import "@fontsource-variable/fraunces";

// The plate is a CSS background of #stage (16:9, letterboxed); the transparent
// three.js canvas fills #stage, so 3D content shares the plate's frame.
const ASPECT = 16 / 9;
const stage = document.getElementById("stage");
const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
renderer.setClearColor(0x000000, 0);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
stage.appendChild(renderer.domElement);

function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const sw = Math.min(w, h * ASPECT);
  const sh = sw / ASPECT;
  Object.assign(stage.style, {
    width: `${sw}px`,
    height: `${sh}px`,
    left: `${(w - sw) / 2}px`,
    top: `${(h - sh) / 2}px`,
  });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(sw, sh, false);
  renderer.getDrawingBufferSize(screenSize.value); // masked proxies sample their mask in screen space
}
window.addEventListener("resize", resize);
resize();

const FADE_MS = 300;
const fade = document.getElementById("fade"); // black overlay over #stage
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const setFade = async (black) => { fade.style.opacity = black ? "1" : "0"; await sleep(FADE_MS + 20); };

// Loads a map (scene JSON + masks) and its plate image; the plate is applied by showMap.
const BASE = import.meta.env.BASE_URL; // "/" in dev, the repo path on GitHub Pages
async function loadMap(id) {
  const w = await loadScene(`${BASE}plates/${id}.scene.json`);
  w.id = id;
  w.plateUrl = `${BASE}plates/${id}.png`;
  await new Promise((res, rej) => { // decode the plate before the swap so it does not pop in
    const img = new Image();
    img.onload = res;
    img.onerror = () => rej(new Error(`cannot load ${w.plateUrl}`));
    img.src = w.plateUrl;
  });
  return w;
}
const showMap = (w) => { stage.style.backgroundImage = `url("${w.plateUrl}")`; };
const findArrival = (w, name) => {
  const a = w.arrivals.find((x) => x.name === name);
  if (!a) throw new Error(`map ${w.id} has no arrival ${name}`);
  return a;
};

const startId = new URLSearchParams(location.search).get("map") || "plate_01";
let world = await loadMap(startId);
showMap(world);
const character = await loadCharacter(`${BASE}models/RobotExpressive.glb`, world.characterHeight);
world.scene.add(character.root);
if (!world.arrivals.length) throw new Error(`map ${world.id} has no arrivals`);
const controller = new Controller({ world, character, canvas: renderer.domElement });
controller.setWorld(world, world.arrivals.find((a) => a.name === "start") || world.arrivals[0]);

// Controls popup: open on start (not under automation, so the smoke checks can click the canvas), H or ? reopens it.
// Input is locked while it is open.
const help = document.getElementById("help");
function setHelp(open) {
  help.hidden = !open;
  if (open) {
    controller.stop();
    for (const a of help.querySelectorAll(".maps a")) a.classList.toggle("here", a.dataset.map === world.id);
  }
  controller.locked = open || transitioning;
}
help.querySelector("button.go").addEventListener("click", () => setHelp(false));
help.addEventListener("click", (e) => { if (e.target === help) setHelp(false); });
document.getElementById("help-open").addEventListener("click", (e) => { e.currentTarget.blur(); setHelp(true); });
window.addEventListener("keydown", (e) => {
  if (e.code === "KeyH") setHelp(help.hidden);
  else if (!help.hidden && (e.code === "Escape" || e.code === "Enter")) setHelp(false);
});

// Map transition: cancel orders, fade to black, swap the map, place the character at the target arrival, fade back.
let transitioning = false;
async function transition(exit) {
  transitioning = true;
  controller.locked = true;
  controller.stop();
  try {
    const next = loadMap(exit.to);
    await setFade(true);
    const nw = await next;
    const arrival = findArrival(nw, exit.arrival);
    const old = world;
    old.scene.remove(character.root);
    nw.scene.add(character.root);
    world = nw;
    showMap(nw);
    controller.setWorld(nw, arrival);
    old.dispose();
    await setFade(false);
  } finally {
    controller.locked = !help.hidden;
    transitioning = false;
  }
}
function checkExits() {
  if (transitioning) return;
  const p = character.root.position;
  const exit = world.exits.find((e) => pointInPolygon(p.x, p.z, e.zone));
  if (exit) transition(exit).catch((err) => console.error("transition failed", err));
}

setHelp(!navigator.webdriver);

// Test hook for tools/smoke.mjs.
window.__debug = {
  get position() { const p = character.root.position; return [p.x, p.y, p.z]; },
  get state() { return controller.state; },
  get yaw() { return character.root.rotation.y; },
  get facing() { const y = character.root.rotation.y; return [Math.sin(y), Math.cos(y)]; }, // x, z of the glTF +Z forward
  get clip() { return character.currentName; },
  get gait() { return controller.gait; },
  get map() { return world.id; },
  get transitioning() { return transitioning; },
  isWalkable: (x, z) => world.walkable.contains(x, z),
  // client pixel coordinates of a world point
  toClient(x, y, z) {
    const v = new THREE.Vector3(x, y, z).project(world.camera);
    const r = renderer.domElement.getBoundingClientRect();
    return [r.left + ((v.x + 1) / 2) * r.width, r.top + ((1 - v.y) / 2) * r.height];
  },
  get scene() { return world.data; },
  heightAt: (x, z) => world.surfaces.heightAt(x, z),
  treadAt: (x, z) => world.surfaces.treadAt(x, z),
  get boneNames() { return character.ik.boneNames; },
  // Leg IK probe: both feet (world position, sole height, pitch from level in degrees), the IK hip raise and its largest bone move.
  ikSample() {
    const ik = character.ik;
    return {
      feet: [0, 1].map((i) => ({ pos: ik.footWorld(i).toArray(), sole: ik.soleY(i), pitch: ik.footPitchDeg(i), footprint: ik.footprintOf(i) })),
      hips: ik.hips, lastMove: ik.lastMove, maxMove: ik.maxMove, rootY: character.root.position.y,
    };
  },
  resetIkMaxMove() { character.ik.maxMove = 0; },
  character,
};

let last = performance.now();
renderer.setAnimationLoop((now) => {
  controller.update(Math.min((now - last) / 1000, 0.1));
  last = now;
  checkExits();
  renderer.render(world.scene, world.camera);
});
