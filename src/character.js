import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { LegIK } from './legik.js';

export const WALK_SPEED = 1.0; // m/s, tuned to the Walking clip (see CLAUDE.md)
const RUN_CLIP_SPEED = 1.8; // m/s, the Running clip's planted-foot speed, right 1.86 / left 1.69 (npm --prefix app run measure)
export const RUN_SPEED = 3.2; // m/s; the Running clip plays faster by RUN_SPEED / RUN_CLIP_SPEED so feet stay planted
// Hips bone at the last frame of the Sitting clip, relative to the character root (m, root facing +Z): measured by tools/measure_clips.mjs.
export const SIT_HIPS = { y: 0.218, back: 0.177 }; // height above the root, distance behind the root

export async function loadCharacter(url, height) {
  const gltf = await new GLTFLoader().loadAsync(url);
  const model = gltf.scene;
  model.updateMatrixWorld(true);
  const size = new THREE.Box3().setFromObject(model).getSize(new THREE.Vector3());
  model.scale.setScalar(height / size.y);
  model.traverse((o) => {
    if (o.isMesh) { o.castShadow = true; o.renderOrder = 1; o.frustumCulled = false; }
  });
  const root = new THREE.Group(); // position and yaw live here; the model keeps its own scale
  root.add(model);

  const mixer = new THREE.AnimationMixer(model);
  const actions = {};
  for (const clip of gltf.animations) actions[clip.name] = mixer.clipAction(clip);
  for (const name of ['Sitting', 'Standing']) {
    actions[name].setLoop(THREE.LoopOnce, 1);
    actions[name].clampWhenFinished = true;
  }
  actions.Running.timeScale = RUN_SPEED / RUN_CLIP_SPEED;
  let current = null;
  const ik = new LegIK(model, root);
  console.info('bones:', ik.boneNames.join(', '));

  return {
    root, model, mixer, actions, ik,
    // One animation step: undo last frame's IK, run the mixer, then apply the leg IK (ikActive: walking or idle on foot).
    update(dt, surfaces, ikActive) {
      ik.restore();
      mixer.update(dt);
      ik.apply(dt, surfaces, ikActive);
    },
    clipDuration: (name) => actions[name].getClip().duration,
    get currentName() { return current ? current.getClip().name : null; },
    play(name, fade = 0.25) {
      const next = actions[name];
      if (!next) throw new Error(`no clip ${name}`);
      if (next === current) return;
      // Fade in from 0 and fade the old action out from its current effective weight (no pop on rapid changes).
      next.reset().fadeIn(fade).play();
      if (current) current.fadeOut(fade);
      current = next;
    },
  };
}
