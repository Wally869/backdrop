import * as THREE from 'three';
import { WALK_SPEED, RUN_SPEED, SIT_HIPS } from './character.js';

const TURN_RATE = 9; // rad/s
const smooth = (k) => k * k * (3 - 2 * k);
const KEYS = {
  KeyW: 'f', ArrowUp: 'f', KeyS: 'b', ArrowDown: 'b', KeyA: 'l', ArrowLeft: 'l', ArrowRight: 'r',
};

const angleDiff = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));

export class Controller {
  constructor({ world, character, canvas }) {
    this.world = world;
    this.char = character;
    this.canvas = canvas;
    this.state = 'idle'; // idle | walking | sitting | standing
    this.path = null; // [[x,z], ...] remaining waypoints
    this.sitAfterPath = false;
    this.orienting = false; // arrived at the front point, turning to the marker facing
    this.keys = new Set();
    this.raycaster = new THREE.Raycaster();
    this.t = 0; // time inside a sit/stand transition
    this.pendingGoal = null;
    this.pendingRun = false;
    this.run = false; // the current order (path) runs
    this.shift = false;
    this.locked = false; // true during a map transition: input ignored
    this.setWorld(world);
    this.char.play('Idle');

    canvas.addEventListener('click', (e) => this.onClick(e));
    window.addEventListener('keydown', (e) => this.onKey(e, true));
    window.addEventListener('keyup', (e) => this.onKey(e, false));
    window.addEventListener('blur', () => { this.keys.clear(); this.shift = false; });
  }

  // Switch to another map: cancels every order and puts the character idle at an arrival [x, z] with yaw facingY.
  setWorld(world, arrival = null) {
    this.world = world;
    const m = world.marker;
    if (m) {
      // The marker is the seat centre (hips target) and faces away from the seat front; the root ends SIT_HIPS.back
      // in front of the marker, so the hips (behind the root in the Sitting clip) land on it, lifted to seat height.
      this.facing = new THREE.Vector2(Math.sin(m.facingY), Math.cos(m.facingY));
      this.front = m.approach; // standing point in front of the seat, where the sit starts
      this.seat = [m.position[0] + this.facing.x * SIT_HIPS.back, m.position[2] + this.facing.y * SIT_HIPS.back];
      this.seatLift = m.position[1] - SIT_HIPS.y;
    }
    this.path = null;
    this.sitAfterPath = false;
    this.orienting = false;
    this.pendingGoal = null;
    this.pendingRun = false;
    this.run = false;
    this.keys.clear();
    this.state = 'idle';
    if (arrival) {
      const root = this.char.root;
      root.position.set(arrival.position[0], world.surfaces.heightAt(arrival.position[0], arrival.position[1]), arrival.position[1]);
      root.rotation.y = arrival.facingY;
      this.char.play('Idle');
    }
  }

  get pos() { return this.char.root.position; }

  // No running on stairs: the run is capped to the walk speed and the Walking clip.
  get onStairs() { return this.world.surfaces.isStairs(this.pos.x, this.pos.z); }

  get gait() { return this.run && !this.onStairs ? 'Running' : 'Walking'; }

  get speed() { return this.gait === 'Running' ? RUN_SPEED : WALK_SPEED; }

  onKey(e, down) {
    if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') { this.shift = down; return; }
    this.shift = e.shiftKey;
    // Ignored in a transition; a key still held after it needs a fresh press (auto-repeat does not re-arm it).
    if (down && (this.locked || (e.repeat && !this.keys.has(KEYS[e.code])))) return;
    // D toggles the debug view (so "move right" is the right arrow key only).
    if (e.code === 'KeyD') {
      if (down && !e.repeat) this.world.debug.visible = !this.world.debug.visible;
      return;
    }
    const k = KEYS[e.code];
    if (!k) return;
    if (down) this.keys.add(k); else this.keys.delete(k);
  }

  pointerRay(e) {
    const r = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.world.camera);
    return this.raycaster.ray;
  }

  onClick(e) {
    if (this.locked) return;
    if (this.state === 'sitting' && this.t < this.sitDuration()) return; // sitting down
    // A double-click delivers click (detail 1), click (detail 2), dblclick. The first click starts a walk order; the
    // second (detail >= 2) replaces it with a run order to the same point. One order is active at a time, and the run wins.
    const run = e.detail >= 2;
    if (this.state === 'standing') {
      if (run && this.pendingGoal) this.pendingRun = true; // double-click on the floor while standing up
      return;
    }
    const ray = this.pointerRay(e);
    this.world.camera.updateMatrixWorld();
    const benchHit = this.raycaster.intersectObjects(this.world.benchMeshes, false)[0];
    if (benchHit) {
      if (this.state !== 'sitting') this.goTo(this.front, true, run);
      return;
    }
    const p = this.groundPoint(ray);
    if (!p) return;
    if (this.state === 'sitting') this.standUp([p.x, p.z], run);
    else this.goTo([p.x, p.z], false, run);
  }

  // Walkable ground point under the pointer ray, or null: the first crossing of the ray with the height field (marched
  // in 5 cm steps, then bisected; a ray above the horizon still hits a landing above the camera's ground level).
  groundPoint(ray) {
    const s = this.world.surfaces, o = ray.origin, d = ray.direction;
    const above = (t) => o.y + d.y * t - s.heightAt(o.x + d.x * t, o.z + d.z * t) > 0;
    let lo = 0;
    if (!above(0)) return null;
    for (let t = 0.05; t < 120; t += 0.05) {
      if (above(t)) { lo = t; continue; }
      let hi = t;
      for (let i = 0; i < 24; i++) { const m = (lo + hi) / 2; if (above(m)) lo = m; else hi = m; }
      const p = ray.at(hi, new THREE.Vector3());
      return this.world.walkable.contains(p.x, p.z) ? p : null;
    }
    return null;
  }

  goTo(goal, sit, run = false) {
    const path = this.world.walkable.findPath([this.pos.x, this.pos.z], goal);
    if (!path) return;
    this.path = path.slice(1);
    this.sitAfterPath = sit;
    this.orienting = false;
    this.run = run;
    this.state = 'walking';
    this.char.play(this.gait);
  }

  sitDuration() { return this.char.clipDuration('Sitting'); }

  startSit() {
    this.state = 'sitting';
    this.t = 0;
    this.sitFrom = [this.pos.x, this.pos.z];
    this.char.play('Sitting');
  }

  standUp(goal, run = false) {
    this.state = 'standing';
    this.t = 0;
    this.pendingGoal = goal;
    this.pendingRun = run;
    this.char.play('Standing');
  }

  stop() {
    this.path = null;
    this.run = false;
    this.state = 'idle';
    this.char.play('Idle');
  }

  turnToward(yaw, dt) {
    const root = this.char.root;
    const d = angleDiff(yaw, root.rotation.y);
    const step = TURN_RATE * dt;
    root.rotation.y += Math.abs(d) <= step ? d : Math.sign(d) * step;
    return Math.abs(d);
  }

  keyboardVector() {
    const f = (this.keys.has('f') ? 1 : 0) - (this.keys.has('b') ? 1 : 0);
    const r = (this.keys.has('r') ? 1 : 0) - (this.keys.has('l') ? 1 : 0);
    if (!f && !r) return null;
    const fwd = new THREE.Vector3();
    this.world.camera.getWorldDirection(fwd);
    fwd.y = 0; fwd.normalize();
    const v = new THREE.Vector2(fwd.x * f + -fwd.z * r, fwd.z * f + fwd.x * r);
    return v.normalize();
  }

  moveBy(dx, dz) {
    const w = this.world.walkable, p = this.pos;
    if (w.contains(p.x + dx, p.z + dz)) { p.x += dx; p.z += dz; return; }
    if (dx && w.contains(p.x + dx, p.z)) p.x += dx; // slide along the edge
    else if (dz && w.contains(p.x, p.z + dz)) p.z += dz;
  }

  update(dt) {
    const pos = this.pos;
    const surfaces = this.world.surfaces;
    if (this.locked) { this.char.update(dt, surfaces, false); return; }
    if (this.state === 'idle' || this.state === 'walking') {
      const kv = this.keyboardVector();
      if (kv) {
        this.path = null; this.orienting = false; this.sitAfterPath = false;
        this.run = this.shift;
        this.state = 'walking';
        this.char.play(this.gait); // crossfades walk <-> run when Shift changes
        this.turnToward(Math.atan2(kv.x, kv.y), dt);
        this.moveBy(kv.x * this.speed * dt, kv.y * this.speed * dt);
      } else if (this.state === 'walking' && this.path) {
        this.char.play(this.gait); // Running -> Walking on stairs and back
        this.followPath(dt);
      } else if (this.state === 'walking' && this.orienting) {
        if (this.turnToward(this.world.marker.facingY, dt) < 0.03) this.startSit();
      } else if (this.state === 'walking') {
        this.stop(); // keys released
      }
      pos.y = surfaces.heightAt(pos.x, pos.z);
    } else if (this.state === 'sitting') {
      this.t += dt;
      if (this.t >= this.sitDuration() && this.keyboardVector()) { this.standUp(null); return; }
      const k = Math.min(1, this.t / this.sitDuration());
      pos.x = this.sitFrom[0] + (this.seat[0] - this.sitFrom[0]) * k;
      pos.z = this.sitFrom[1] + (this.seat[1] - this.sitFrom[1]) * k;
      pos.y = this.seatLift * smooth(k); // hips end at seat height
    } else if (this.state === 'standing') {
      this.t += dt;
      const dur = this.char.clipDuration('Standing');
      const k = Math.min(1, this.t / dur);
      pos.x = this.seat[0] + (this.front[0] - this.seat[0]) * k;
      pos.z = this.seat[1] + (this.front[1] - this.seat[1]) * k;
      pos.y = this.seatLift * (1 - smooth(k));
      if (this.t >= dur) {
        const g = this.pendingGoal;
        this.pendingGoal = null;
        pos.y = surfaces.heightAt(pos.x, pos.z);
        if (g) this.goTo(g, false, this.pendingRun); // straight to Walking/Running, no fade to Idle in between
        if (this.state === 'standing') this.stop(); // no goal, or no path to it
      }
    }
    this.char.update(dt, surfaces, this.state === 'idle' || this.state === 'walking');
  }

  followPath(dt) {
    const pos = this.pos;
    let step = this.speed * dt;
    while (this.path.length && step > 0) {
      const [tx, tz] = this.path[0];
      const dx = tx - pos.x, dz = tz - pos.z, d = Math.hypot(dx, dz);
      if (d > 1e-6) this.turnToward(Math.atan2(dx, dz), dt);
      if (d <= step) { pos.x = tx; pos.z = tz; step -= d; this.path.shift(); } else { pos.x += (dx / d) * step; pos.z += (dz / d) * step; step = 0; }
    }
    if (!this.path.length) {
      this.path = null;
      if (this.sitAfterPath) { this.sitAfterPath = false; this.orienting = true; this.char.play('Idle'); } else this.stop();
    }
  }
}
