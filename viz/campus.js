/* The campus object, alone.

   The same object the globe uses (campus3d.js), in the same key (theme3d.js), lit the
   same way — on an empty page with nothing around it. Drag to orbit, scroll to zoom.

   The page has no chrome; everything is a URL parameter:
     ?theme=light|dark   the key            ?site=us|eu|ap      whose colour it wears
     ?state=<preset>     empty · start · stranded · unserved · genN · full
     ?spin=0             stop the auto-orbit
*/
import * as THREE from 'three';
import { EffectComposer } from './vendor/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from './vendor/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from './vendor/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from './vendor/jsm/postprocessing/OutputPass.js';
import { Campus } from './campus3d.js';
import { useTheme } from './theme3d.js';

const Q = new URLSearchParams(location.search);
const { LIGHT, T, metal } = useTheme();
const POWER_MW = { H: 1.4, N: 1.6 };      // MW per thousand GPUs, from world.py
const COMPUTE = { H: 1, N: 2 };           // kH per thousand

// what the object is showing. powered and served are derived the way world.py derives
// them: gen N takes the megawatts first, gen H gets whatever is left.
const STATES = {
  empty:    { ownedH: 0, ownedN: 0, mw: 0, mwPending: 8, reserved: 0, option: 0, spot: 0, demand: 1.2 },
  start:    { ownedH: 6, ownedN: 0, mw: 10, mwPending: 0, reserved: 2, option: 0, spot: 0, demand: 3 },
  stranded: { ownedH: 14, ownedN: 0, mw: 8.4, mwPending: 12, reserved: 0, option: 0, spot: 0, demand: 5 },
  unserved: { ownedH: 3, ownedN: 0, mw: 4.2, mwPending: 0, reserved: 0, option: 0, spot: 1, demand: 11 },
  genN:     { ownedH: 2, ownedN: 7, mw: 14, mwPending: 0, reserved: 0, option: 0, spot: 0, demand: 8 },
  full:     { ownedH: 8, ownedN: 4, mw: 18, mwPending: 9, reserved: 5, option: 3.5, spot: 4.5, demand: 14 },
};
const S = STATES[Q.get('state')] || STATES.full;

function derive() {
  const poweredN = Math.min(S.ownedN, S.mw / POWER_MW.N);
  const poweredH = Math.min(S.ownedH, (S.mw - poweredN * POWER_MW.N) / POWER_MW.H);
  const capacity = poweredN * COMPUTE.N + poweredH * COMPUTE.H + S.reserved + S.option + S.spot;
  const served = Math.min(S.demand, capacity);
  return { ...S, poweredH, poweredN, served, training: capacity - served, unserved: S.demand - served };
}

// ---------------------------------------------------------------- stage
const stage = document.getElementById('stage');
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.toneMapping = LIGHT ? THREE.NoToneMapping : THREE.ACESFilmicToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
stage.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(T.bg);
const camera = new THREE.PerspectiveCamera(38, 1, 0.5, 600);

scene.add(new THREE.AmbientLight(0xffffff, T.amb));
const key = new THREE.DirectionalLight(0xffffff, T.keyLight * (LIGHT ? 1 : 1.4));
key.position.set(26, 40, 22);
key.castShadow = true;
key.shadow.mapSize.set(1024, 1024);
Object.assign(key.shadow.camera, { left: -30, right: 30, top: 30, bottom: -30, near: 1, far: 140 });
scene.add(key);
const fill = new THREE.DirectionalLight(T.fillHue, T.fillLight);
fill.position.set(-30, 14, -24);
scene.add(fill);

let composer = null;
if (!LIGHT) {
  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(new UnrealBloomPass(new THREE.Vector2(1, 1), 0.34, 0.5, 0.9));
  composer.addPass(new OutputPass());
}

const site = ['us', 'eu', 'ap'].includes(Q.get('site')) ? Q.get('site') : 'us';
const campus = new Campus({ theme: T, color: T.site[site], slots: 16, metal });
scene.add(campus.group);

// ---------------------------------------------------------------- orbit
const view = { r: 42, theta: 0.72, phi: 1.02, auto: Q.get('spin') !== '0', drag: 0 };
const target = new THREE.Vector3(0, 4.5, 0);
{
  const dom = renderer.domElement;
  let last = { x: 0, y: 0 };
  dom.addEventListener('pointerdown', e => {
    view.drag = 1; last = { x: e.clientX, y: e.clientY }; dom.setPointerCapture(e.pointerId);
  });
  dom.addEventListener('pointermove', e => {
    if (!view.drag) return;
    view.theta -= (e.clientX - last.x) * 0.006;
    view.phi = THREE.MathUtils.clamp(view.phi - (e.clientY - last.y) * 0.005, 0.12, Math.PI / 2 - 0.02);
    last = { x: e.clientX, y: e.clientY };
  });
  const end = () => { view.drag = 0; };
  dom.addEventListener('pointerup', end);
  dom.addEventListener('pointercancel', end);
  dom.addEventListener('wheel', e => {
    e.preventDefault();
    view.r = THREE.MathUtils.clamp(view.r * (1 + Math.sign(e.deltaY) * 0.09), 16, 150);
  }, { passive: false });
}

// ---------------------------------------------------------------- loop
function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  composer?.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

let t0 = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - t0) / 1000); t0 = now;
  if (view.auto && !view.drag) view.theta += dt * 0.18;
  const s = Math.sin(view.phi);
  camera.position.set(view.r * s * Math.sin(view.theta),
                      target.y + view.r * Math.cos(view.phi),
                      view.r * s * Math.cos(view.theta));
  camera.lookAt(target);

  campus.update(derive(), now / 1000);
  (composer || renderer).render(scene, camera);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
