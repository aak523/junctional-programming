/* The training runs, alone.

   The same object the globe uses (training3d.js), in the same key (theme3d.js), lit the
   same way — on an empty page with nothing around it. Drag to orbit, scroll to zoom.

   The page has no chrome; everything is a URL parameter:
     ?theme=light|dark   the key
     ?state=<preset>     cold · window1 · sealed1 · behind · missed2 · overshot · end
     ?spin=0             stop the auto-orbit
*/
import * as THREE from 'three';
import { EffectComposer } from './vendor/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from './vendor/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from './vendor/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from './vendor/jsm/postprocessing/OutputPass.js';
import { Training, MILESTONES, GANTRY_Y } from './training3d.js';
import { useTheme } from './theme3d.js';

const Q = new URLSearchParams(location.search);
const { LIGHT, T, metal } = useTheme();

// What the object is showing: the month, and the training kH every finished month put
// into the global pool (history[k]["training"] in world.py, indexed by month). `met` is
// not in the presets — it is derived below the way end_month writes it, once, from the
// window's own months only.
const STATES = {
  // month 0: nothing has run yet, window 1 open with all eight months to go
  cold:     { month: 0, perMonth: [] },
  // four months in, averaging more than the 7.5/month window 1 needs
  window1:  { month: 4, perMonth: [7, 8, 8.5, 9] },
  // window 1 closed at 69 of 60 — met and capped; window 2 opens needing 17.5/month
  sealed1:  { month: 8, perMonth: [7, 8, 8.5, 9, 9, 8.5, 9, 10] },
  // window 2 at 71 of 140 with two months left: 34.5/month, far past its best month
  behind:   { month: 14, perMonth: [7, 8, 8.5, 9, 9, 8.5, 9, 10, 10, 11, 12, 12, 13, 13] },
  // window 2 sealed 41 short; window 3 running, and already needing 41.4/month
  missed2:  { month: 17, perMonth: [7, 8, 8.5, 9, 9, 8.5, 9, 10, 10, 11, 12, 12, 13, 13, 14, 14, 30] },
  // 228 poured into window 2 for a 140 target: 88 kH-months bought nothing, and window 3
  // is now out of reach
  overshot: { month: 20, perMonth: [7, 8, 8.5, 9, 9, 8.5, 9, 10, 24, 26, 28, 30, 30, 32, 30, 28, 20, 18, 16, 15] },
  // the finished game: window 1 met, window 2 missed by 41, window 3 met at 324
  end:      { month: 24, perMonth: [7, 8, 8.5, 9, 9, 8.5, 9, 10, 10, 11, 12, 12, 13, 13, 14, 14,
                                    30, 36, 40, 42, 44, 46, 44, 42] },
};
const S = STATES[Q.get('state')] || STATES.missed2;

// met[d] exactly as end_month writes it: at the end of month d, from that window's months
function derive() {
  const met = {};
  for (const [a, d, target] of MILESTONES) {
    if (S.month <= d) continue;
    let acc = 0;
    for (let k = a; k <= d; k++) acc += Math.max(0, S.perMonth[k] ?? 0);
    met[d] = acc >= target - 1e-9;
  }
  return { ...S, met };
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
const camera = new THREE.PerspectiveCamera(38, 1, 0.5, 900);

scene.add(new THREE.AmbientLight(0xffffff, T.amb));
const key = new THREE.DirectionalLight(0xffffff, T.keyLight * (LIGHT ? 1 : 1.4));
key.position.set(34, 52, 30);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
Object.assign(key.shadow.camera, { left: -38, right: 38, top: 38, bottom: -38, near: 1, far: 200 });
scene.add(key);
const fill = new THREE.DirectionalLight(T.fillHue, T.fillLight * (LIGHT ? 1 : 2.2));
fill.position.set(-36, 18, -30);
scene.add(fill);
const back = new THREE.DirectionalLight(0xffffff, LIGHT ? 0.1 : 0.35);
back.position.set(-22, 26, 32);
scene.add(back);

let composer = null;
if (!LIGHT) {
  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(new UnrealBloomPass(new THREE.Vector2(1, 1), 0.34, 0.5, 0.9));
  composer.addPass(new OutputPass());
}

const runs = new Training({ theme: T, color: T.crown, metal });
scene.add(runs.group);

// ---------------------------------------------------------------- orbit
const view = { r: 27, theta: 0.42, phi: 1.06, auto: Q.get('spin') !== '0', drag: 0 };
const target = new THREE.Vector3(0, GANTRY_Y * 0.48, 0);
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
    view.r = THREE.MathUtils.clamp(view.r * (1 + Math.sign(e.deltaY) * 0.09), 22, 220);
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

const state = derive();
let t0 = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - t0) / 1000); t0 = now;
  if (view.auto && !view.drag) view.theta += dt * 0.14;
  const s = Math.sin(view.phi);
  camera.position.set(view.r * s * Math.sin(view.theta),
                      target.y + view.r * Math.cos(view.phi),
                      view.r * s * Math.cos(view.theta));
  camera.lookAt(target);

  runs.update(state, now / 1000);
  (composer || renderer).render(scene, camera);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
