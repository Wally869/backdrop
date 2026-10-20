import * as THREE from 'three';

// Single camera construction shared by the app and tools/project_scene.mjs.
export function buildCamera(sceneData) {
  const c = sceneData.camera;
  const cam = new THREE.PerspectiveCamera(c.fovVertical, 16 / 9, c.near, c.far);
  cam.position.set(...c.position);
  cam.rotation.set(c.rotationEuler[0], c.rotationEuler[1], c.rotationEuler[2], c.rotationOrder);
  cam.updateMatrixWorld(true);
  cam.updateProjectionMatrix();
  return cam;
}
