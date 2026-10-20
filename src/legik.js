import * as THREE from 'three';

// Two-bone leg IK for RobotExpressive on stairs. The rig keeps the feet (FootL / FootR) as separate bones under the
// root bone, so the clip drives the feet directly and the legs (UpperLeg -> LowerLeg -> LowerLeg_end) only follow them.
// Each frame, after the mixer: every foot is raised by (tread under the foot - body height), the hips (Body bone) go
// up by the lower foot's raise, the sole is levelled while the foot is near the ground, and the knee is solved for the
// new foot position. All offsets are 0 on flat ground, where nothing is touched.

const ANKLE_OFFSET = 0.00927859637886286; // LowerLeg.L_end / .R_end translation along the shin bone's y axis (GLB units)
const TAU = 0.06; // s, smoothing of the offsets (a swing foot crosses a nosing without a pop)
const EPS = 1e-6;
const SNAP = 1e-4; // m, a smoothed floor height this close to its goal snaps to it
const LATCH_ENTER = 0.02; // m above the foot's rest height: the foot is planted, its floor height is held
const PLANT_SPEED = 0.4; // m/s: a foot this slow over the ground (and low) is planted
const PLANT_RELEASE_SPEED = 0.8; // m/s: a latched foot faster than this has lifted
const LATCH_RELEASE = 0.04; // m: the foot has lifted, the floor height follows the tread under it again
const LEVEL_FULL = 0.02; // m above the foot's rest height: sole fully levelled
const LEVEL_NONE = 0.08; // m above the foot's rest height: clip pitch kept (swing)

const P = new THREE.Vector3(), Q = new THREE.Quaternion(), Q2 = new THREE.Quaternion();
const V1 = new THREE.Vector3(), V2 = new THREE.Vector3(), V3 = new THREE.Vector3();
const AXES = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].map((a) => new THREE.Vector3(...a));

// Premultiplies the world rotation of a bone by q.
const RW1 = new THREE.Quaternion(), RW2 = new THREE.Quaternion();
function rotateWorld(bone, q) {
  bone.getWorldQuaternion(RW1).premultiply(q);
  bone.parent.getWorldQuaternion(RW2).invert();
  bone.quaternion.copy(RW2.multiply(RW1));
  bone.updateMatrixWorld(true);
}

export class LegIK {
  constructor(model, root) {
    this.root = root;
    const bones = {};
    model.traverse((o) => { if (o.isBone) bones[o.name] = o; });
    this.boneNames = Object.keys(bones);
    const get = (n) => {
      if (!bones[n]) throw new Error(`no bone ${n}; bones: ${this.boneNames.join(', ')}`);
      return bones[n];
    };
    this.body = get('Body');
    this.legs = ['L', 'R'].map((side) => {
      const lower = get(`LowerLeg${side}`);
      // The GLB has an end node at the ankle that the loader drops; recreate it (offset from the file, LowerLeg.*_end).
      const ankle = new THREE.Object3D();
      ankle.position.set(0, ANKLE_OFFSET, 0);
      lower.add(ankle);
      return { side, upper: get(`UpperLeg${side}`), lower, ankle, foot: get(`Foot${side}`), d: 0, floor: null, latched: null, clipHeight: 0, ankleLocal: new THREE.Vector3() };
    });
    this.hips = 0;
    this.lastMove = 0; // m, largest bone displacement caused by the last apply()
    this.maxMove = 0;
    this.saved = new Map();
    // Calibration on the rest pose (root at the origin, yaw 0): the foot axis that points up, the foot height, the sole pitch.
    root.updateMatrixWorld(true);
    for (const leg of this.legs) {
      leg.mesh = leg.foot.children.find((c) => c.isMesh) || null;
      if (!leg.mesh) throw new Error(`bone ${leg.foot.name} has no foot mesh`);
      // Heel and toe along the character's forward axis, relative to the foot bone (foot mesh extent in the root frame).
      leg.mesh.updateWorldMatrix(true, false);
      if (leg.mesh.skeleton) leg.mesh.skeleton.update();
      const toRoot = new THREE.Matrix4().copy(root.matrixWorld).invert();
      let zMin = Infinity, zMax = -Infinity;
      for (let k = 0; k < leg.mesh.geometry.attributes.position.count; k++) {
        const z = leg.mesh.getVertexPosition(k, V1).applyMatrix4(leg.mesh.matrixWorld).applyMatrix4(toRoot).z;
        zMin = Math.min(zMin, z); zMax = Math.max(zMax, z);
      }
      const z0 = leg.foot.getWorldPosition(P).applyMatrix4(toRoot).z;
      leg.heel = zMin - z0; leg.toe = zMax - z0;
      leg.foot.getWorldQuaternion(Q);
      let best = -2;
      for (const a of AXES) {
        const dot = V1.copy(a).applyQuaternion(Q).y;
        if (dot > best) { best = dot; leg.upAxis = a; }
      }
      leg.restHeight = leg.foot.getWorldPosition(P).y - root.position.y;
      leg.restPitch = this.pitch(leg);
    }
    console.info('foot heel/toe (m, root frame):', this.legs.map((l) => `${l.side} ${l.heel.toFixed(3)} ${l.toe.toFixed(3)} up axis ${l.upAxis.toArray()} rest pitch ${(l.restPitch * 57.3).toFixed(1)} deg`).join('; '));
  }

  // Heel and toe of a foot on the ground plane (world), and the floor height they stand on (the higher of the two).
  footprint(leg, foot = leg.foot.getWorldPosition(new THREE.Vector3()), surfaces) {
    const fwd = V3.set(0, 0, 1).applyQuaternion(this.root.getWorldQuaternion(Q));
    const heel = [foot.x + fwd.x * leg.heel, foot.z + fwd.z * leg.heel];
    const toe = [foot.x + fwd.x * leg.toe, foot.z + fwd.z * leg.toe];
    return { heel, toe, floor: surfaces ? Math.max(surfaces.treadAt(...heel), surfaces.treadAt(...toe), surfaces.treadAt(foot.x, foot.z)) : 0 };
  }

  // Test hook: world positions [x, z] of heel and toe of foot i.
  footprintOf(i) {
    this.root.updateMatrixWorld(true);
    const f = this.footprint(this.legs[i]);
    return [f.heel, f.toe];
  }

  // Sole pitch about the character's lateral axis, radians, toe-down positive.
  pitch(leg) {
    const u = V1.copy(leg.upAxis).applyQuaternion(leg.foot.getWorldQuaternion(Q));
    u.applyQuaternion(this.root.getWorldQuaternion(Q2).invert());
    return Math.atan2(u.z, u.y);
  }

  // Test hooks. Pitch (deg) away from the rest pitch (sole level), and lowest world y of the foot mesh.
  footPitchDeg(i) {
    this.root.updateMatrixWorld(true);
    const leg = this.legs[i];
    return ((this.pitch(leg) - leg.restPitch) * 180) / Math.PI;
  }

  soleY(i) {
    const m = this.legs[i].mesh;
    if (!m) throw new Error(`foot ${i} has no mesh`);
    this.root.updateMatrixWorld(true);
    if (m.skeleton) m.skeleton.update();
    let low = Infinity;
    const n = m.geometry.attributes.position.count;
    for (let k = 0; k < n; k++) low = Math.min(low, m.getVertexPosition(k, V1).applyMatrix4(m.matrixWorld).y);
    return low;
  }

  footWorld(i) { return this.legs[i].foot.getWorldPosition(new THREE.Vector3()); }

  save(b) { if (!this.saved.has(b)) this.saved.set(b, { p: b.position.clone(), q: b.quaternion.clone() }); }

  // Undo this frame's changes (call before the mixer update; bones the clip does not drive would keep them).
  restore() {
    for (const [b, s] of this.saved) { b.position.copy(s.p); b.quaternion.copy(s.q); }
    this.saved.clear();
  }

  reset() {
    this.hips = 0;
    this.lastMove = 0;
    for (const leg of this.legs) { leg.d = 0; leg.floor = null; leg.latched = null; leg.prev = null; }
  }

  apply(dt, surfaces, active) {
    this.lastMove = 0;
    if (!active) { this.reset(); return; }
    const root = this.root;
    root.updateMatrixWorld(true);
    const rootH = surfaces.heightAt(root.position.x, root.position.z);
    const a = 1 - Math.exp(-dt / TAU);
    let live = false;
    for (const leg of this.legs) {
      leg.foot.getWorldPosition(P);
      leg.clipHeight = P.y - rootH - leg.restHeight;
      const raw = this.footprint(leg, P, surfaces).floor; // the foot rests on the higher tread under heel / toe
      // A planted foot keeps the height it landed on (its drift across a nosing must not make it jump).
      const speed = leg.prev && dt > 0 ? Math.hypot(P.x - leg.prev[0], P.z - leg.prev[1]) / dt : Infinity; // clip foot speed over the ground
      leg.prev = [P.x, P.z];
      if (leg.latched !== null && (leg.clipHeight > LATCH_RELEASE || speed > PLANT_RELEASE_SPEED)) leg.latched = null;
      else if (leg.latched === null && leg.clipHeight < LATCH_ENTER && speed < PLANT_SPEED) leg.latched = raw;
      const goal = leg.latched ?? raw;
      // Smooth the absolute floor height (not the offset to the body, which moves with the stairs: that would lag).
      leg.floor = leg.floor === null ? goal : leg.floor + (goal - leg.floor) * a;
      if (Math.abs(goal - leg.floor) < SNAP) leg.floor = goal;
      leg.d = leg.floor - rootH;
      if (leg.d !== 0) live = true;
    }
    if (!live) { this.hips = 0; return; }
    this.hips = Math.min(this.legs[0].d, this.legs[1].d);

    const watch = [this.body];
    for (const leg of this.legs) watch.push(leg.upper, leg.lower, leg.ankle, leg.foot);
    const before = watch.map((b) => b.getWorldPosition(new THREE.Vector3()));

    this.save(this.body);
    for (const leg of this.legs) {
      this.save(leg.foot); this.save(leg.upper); this.save(leg.lower);
      leg.foot.worldToLocal(leg.ankleLocal.copy(leg.ankle.getWorldPosition(P)));
    }
    this.body.getWorldPosition(P).y += this.hips;
    this.body.position.copy(this.body.parent.worldToLocal(P));
    this.body.updateMatrixWorld(true);

    const lateral = V3.set(1, 0, 0).applyQuaternion(root.getWorldQuaternion(Q));
    for (const leg of this.legs) {
      const target = leg.foot.getWorldPosition(new THREE.Vector3());
      target.y += leg.d;
      // Level the sole while the foot is near the ground; the swing keeps the clip's pitch.
      const k = Math.min(1, Math.max(0, (leg.clipHeight - LEVEL_FULL) / (LEVEL_NONE - LEVEL_FULL)));
      const w = 1 - k * k * (3 - 2 * k);
      const dp = this.pitch(leg) - leg.restPitch;
      if (w > 0) rotateWorld(leg.foot, Q2.setFromAxisAngle(lateral, -dp * w));
      leg.foot.position.copy(leg.foot.parent.worldToLocal(target.clone()));
      leg.foot.updateMatrixWorld(true);
      this.solveLeg(leg, leg.foot.localToWorld(leg.ankleLocal.clone()));
    }
    watch.forEach((b, i) => { this.lastMove = Math.max(this.lastMove, b.getWorldPosition(P).distanceTo(before[i])); });
    this.maxMove = Math.max(this.maxMove, this.lastMove);
  }

  // Bends the knee so that the ankle reaches T (world), in the plane of the hip, the old knee and T.
  solveLeg(leg, T) {
    const H = leg.upper.getWorldPosition(new THREE.Vector3());
    const K = leg.lower.getWorldPosition(new THREE.Vector3());
    const A = leg.ankle.getWorldPosition(new THREE.Vector3());
    const l1 = K.distanceTo(H), l2 = A.distanceTo(K);
    const ax = T.clone().sub(H);
    const D = Math.min(Math.max(ax.length(), Math.abs(l1 - l2) + 1e-4), l1 + l2 - 1e-4);
    ax.normalize();
    const pole = K.clone().sub(H);
    pole.addScaledVector(ax, -pole.dot(ax));
    if (pole.length() < 1e-5) { // straight leg: bend forward
      pole.set(0, 0, 1).applyQuaternion(this.root.getWorldQuaternion(Q));
      pole.addScaledVector(ax, -pole.dot(ax));
    }
    pole.normalize();
    const along = (l1 * l1 - l2 * l2 + D * D) / (2 * D);
    const h = Math.sqrt(Math.max(0, l1 * l1 - along * along));
    const K2 = H.clone().addScaledVector(ax, along).addScaledVector(pole, h);
    rotateWorld(leg.upper, Q2.setFromUnitVectors(K.sub(H).normalize(), K2.clone().sub(H).normalize()));
    leg.lower.getWorldPosition(K2);
    leg.ankle.getWorldPosition(A);
    rotateWorld(leg.lower, Q2.setFromUnitVectors(A.sub(K2).normalize(), T.clone().sub(K2).normalize()));
  }
}
