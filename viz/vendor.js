/* The vendor object, alone.

   The same object the globe uses (vendor3d.js), in the same key (theme3d.js), lit the
   same way — on an empty page with nothing around it. Drag to orbit, scroll to zoom.

   The page has no chrome; everything is a URL parameter:
     ?theme=light|dark   the key
     ?state=<preset>     idle · start · starved · tight · export · postlaunch · both
     ?spin=0             stop the auto-orbit
*/
import * as THREE from 'three';
import { EffectComposer } from './vendor/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from './vendor/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from './vendor/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from './vendor/jsm/postprocessing/OutputPass.js';
import { Vendor, ALLOC, EXPORT_ALLOC, K, LANE_MIN, PLANT_D } from './vendor3d.js';
import { useTheme } from './theme3d.js';

const Q = new URLSearchParams(location.search);
const { LIGHT, T, metal } = useTheme();

/* The presets are the visible queue plus the two hidden things that set the pour: the
   regime, and this month's U(0.7,1.3) allocation noise. `noise` stands in for the
   pre-drawn alloc_noise[k][gen]. Orders are listed in insertion order — that is the
   whole point of the object — with `placed` as the month they were ordered. */
const STATES = {
  // the fab running with nobody in the line: a full H hopper pouring onto an empty dock
  idle: { month: 6, regime: 'loose', noise: { H: 1.05, N: 0.95 }, queue: [] },

  // month 0 of every game: order #1, 4k gen H to us, placed in month -2, eligible now
  start: { month: 0, regime: 'loose', noise: { H: 1.0, N: 1.0 },
    queue: [{ gen: 'H', site: 'us', qty: 4.0, left: 4.0, placed: -2 }] },

  // the coupling: a 30k us order at the head, part-shipped, starving everything behind it
  starved: { month: 9, regime: 'loose', noise: { H: 1.04, N: 1.1 },
    queue: [
      { gen: 'H', site: 'us', qty: 30.0, left: 22.4, placed: 4 },
      { gen: 'H', site: 'ap', qty: 2.0, left: 2.0, placed: 5 },
      { gen: 'H', site: 'eu', qty: 6.0, left: 6.0, placed: 6 },
      { gen: 'H', site: 'ap', qty: 4.0, left: 4.0, placed: 8 },
      { gen: 'H', site: 'us', qty: 5.0, left: 5.0, placed: 9 },   // placed this month: not at the window
    ] },

  // tight regime: the same line, a hopper a third the size
  tight: { month: 11, regime: 'tight', noise: { H: 0.9, N: 1.15 },
    queue: [
      { gen: 'H', site: 'eu', qty: 8.0, left: 5.6, placed: 7 },
      { gen: 'H', site: 'us', qty: 3.0, left: 3.0, placed: 8 },
      { gen: 'H', site: 'ap', qty: 2.0, left: 2.0, placed: 9 },
    ] },

  // export controls: the H budget x 0.4, red on the H side, gen N untouched
  export: { month: 8, regime: 'loose', noise: { H: 1.12, N: 1.0 }, exportActive: true,
    queue: [
      { gen: 'H', site: 'us', qty: 12.0, left: 9.8, placed: 3 },
      { gen: 'H', site: 'eu', qty: 6.0, left: 6.0, placed: 5 },
      { gen: 'H', site: 'ap', qty: 3.0, left: 3.0, placed: 6 },
    ] },

  // after the launch: H discontinued, its remnant still draining, N flowing
  postlaunch: { month: 15, regime: 'loose', noise: { H: 0.95, N: 1.08 }, launched: true,
    queue: [
      { gen: 'H', site: 'ap', qty: 4.0, left: 1.2, placed: 11 },
      { gen: 'N', site: 'us', qty: 6.0, left: 4.4, placed: 12 },
      { gen: 'N', site: 'eu', qty: 3.0, left: 3.0, placed: 13 },
    ] },

  // both queues long at once: the month the launch lands on a loaded H book
  both: { month: 14, regime: 'loose', noise: { H: 1.2, N: 1.25 }, launched: true,
    queue: [
      { gen: 'H', site: 'us', qty: 18.0, left: 11.0, placed: 8 },
      { gen: 'H', site: 'eu', qty: 7.0, left: 7.0, placed: 9 },
      { gen: 'H', site: 'ap', qty: 5.0, left: 5.0, placed: 10 },
      { gen: 'N', site: 'us', qty: 10.0, left: 8.0, placed: 12 },
      { gen: 'N', site: 'ap', qty: 4.0, left: 4.0, placed: 13 },
      { gen: 'N', site: 'eu', qty: 6.0, left: 6.0, placed: 14 },   // placed this month
    ] },
};
const S = STATES[Q.get('state')] || STATES.starved;

// the month's budget, derived exactly as world.py does it:
//   ALLOC[gen][regime[k]] x alloc_noise[k][gen] x (0.4 if gen H and export controls are on)
function derive() {
  const budget = {};
  for (const gen of ['H', 'N']) {
    budget[gen] = ALLOC[gen][S.regime] * S.noise[gen]
      * (gen === 'H' && S.exportActive ? EXPORT_ALLOC : 1);
  }
  return { month: S.month, launched: !!S.launched, exportActive: !!S.exportActive,
           budget, queue: S.queue };
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
key.shadow.mapSize.set(1024, 1024);
Object.assign(key.shadow.camera, { left: -44, right: 44, top: 44, bottom: -44, near: 1, far: 200 });
scene.add(key);
const fill = new THREE.DirectionalLight(T.fillHue, T.fillLight * (LIGHT ? 1 : 2.2));
fill.position.set(-38, 18, -30);
scene.add(fill);
const back = new THREE.DirectionalLight(0xffffff, LIGHT ? 0.1 : 0.35);
back.position.set(-22, 26, 34);
scene.add(back);

let composer = null;
if (!LIGHT) {
  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(new UnrealBloomPass(new THREE.Vector2(1, 1), 0.34, 0.5, 0.9));
  composer.addPass(new OutputPass());
}

const fab = new Vendor({ theme: T, metal });
scene.add(fab.group);

// ---------------------------------------------------------------- orbit
// the fab is as long as its order book, so the bench frames it from the book it is given
const book = ['H', 'N'].map(g => S.queue.filter(o => o.gen === g).reduce((a, o) => a + o.qty, 0) * K);
const yard = Math.max(LANE_MIN, Math.max(...book) + 3.2);
const view = { r: THREE.MathUtils.clamp(26 + yard * 0.95, 44, 120), theta: 0.56, phi: 0.84,
               auto: Q.get('spin') !== '0', drag: 0 };
const target = new THREE.Vector3(0, 5.0, (yard + 3 - PLANT_D) / 2);
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
    view.r = THREE.MathUtils.clamp(view.r * (1 + Math.sign(e.deltaY) * 0.09), 20, 260);
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

// the pour is a monthly event; on the bench it restages itself every few seconds
let nextPour = 1.0;

let t0 = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - t0) / 1000); t0 = now;
  const time = now / 1000;
  if (view.auto && !view.drag) view.theta += dt * 0.14;
  const s = Math.sin(view.phi);
  camera.position.set(view.r * s * Math.sin(view.theta),
                      target.y + view.r * Math.cos(view.phi),
                      target.z + view.r * s * Math.cos(view.theta));
  camera.lookAt(target);

  if (time > nextPour) { fab.pour('H'); fab.pour('N'); nextPour = time + 5; }
  fab.update(derive(), time);
  (composer || renderer).render(scene, camera);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
