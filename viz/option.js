/* The capacity-option object, alone.

   The same object the globe uses (option3d.js), in the same key (theme3d.js), lit the
   same way — on an empty page with nothing around it. Drag to orbit, scroll to zoom.

   The page has no chrome; everything is a URL parameter:
     ?theme=light|dark   the key
     ?state=<preset>     empty · bought · split · tight · expiring · tails · lapsed
     ?spin=0             stop the auto-orbit
*/
import * as THREE from 'three';
import { EffectComposer } from './vendor/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from './vendor/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from './vendor/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from './vendor/jsm/postprocessing/OutputPass.js';
import { Options, OPTION_TERM } from './option3d.js';
import { useTheme } from './theme3d.js';

const Q = new URLSearchParams(location.search);
const { LIGHT, T, metal } = useTheme();

/* The presets name the month each option was exercised (`at`); start and end are derived
   below exactly as world.py derives them in exercise_option: start = t + 1 and
   end = t + 1 + OPTION_TERM, so the active months are start .. end − 1. */
const STATES = {
  // nothing bought yet: an empty cradle riding the horizon
  empty:    { month: 5, pool: 0, boughtThisMonth: 0, exercised: [] },
  // the monthly cap taken in one go: 20 kH at $1M each, the frame full
  bought:   { month: 3, pool: 20, boughtThisMonth: 20, exercised: [] },
  // half the pool exercised across two sites, half still held
  split:    { month: 8, pool: 10, boughtThisMonth: 0,
              exercised: [{ qty: 6, site: 'us', at: 6 }, { qty: 4, site: 'ap', at: 7 }] },
  // the case options exist for: a tight month caps reservations at 1.0 kH per site, so
  // these three bars are the only contracted capacity that could be added at all
  tight:    { month: 11, pool: 9, boughtThisMonth: 8,
              exercised: [{ qty: 7, site: 'us', at: 10 }, { qty: 6, site: 'eu', at: 10 },
                          { qty: 5, site: 'ap', at: 10 }, { qty: 4, site: 'us', at: 7 }] },
  // the last month to use them: 14 kH about to expire worthless, premium already sunk
  expiring: { month: 23, pool: 14, boughtThisMonth: 0,
              exercised: [{ qty: 8, site: 'eu', at: 9 }] },
  // mixed: old contracts paid off, late ones whose tails run past month 23
  tails:    { month: 21, pool: 6, boughtThisMonth: 6,
              exercised: [{ qty: 9, site: 'us', at: 20 }, { qty: 5, site: 'ap', at: 21 },
                          { qty: 7, site: 'eu', at: 14 }, { qty: 3, site: 'us', at: 4 }] },
  // after the horizon: what was never exercised is tipped off the end of the rail
  lapsed:   { month: 24, pool: 0, boughtThisMonth: 0, expired: 12,
              exercised: [{ qty: 6, site: 'eu', at: 22 }] },
};
const S = STATES[Q.get('state')] || STATES.tight;

const derive = () => ({
  ...S,
  exercised: S.exercised.map(c => ({
    qty: c.qty, site: c.site, start: c.at + 1, end: c.at + 1 + OPTION_TERM,
  })),
});

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
const fill = new THREE.DirectionalLight(T.fillHue, T.fillLight * (LIGHT ? 1 : 2.2));
fill.position.set(-30, 14, -24);
scene.add(fill);
const back = new THREE.DirectionalLight(0xffffff, LIGHT ? 0.1 : 0.35);
back.position.set(-18, 20, 26);
scene.add(back);

let composer = null;
if (!LIGHT) {
  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(new UnrealBloomPass(new THREE.Vector2(1, 1), 0.34, 0.5, 0.9));
  composer.addPass(new OutputPass());
}

const options = new Options({ theme: T, metal });
scene.add(options.group);

// ---------------------------------------------------------------- orbit
const view = { r: 16, theta: 0.42, phi: 1.00, auto: Q.get('spin') !== '0', drag: 0 };
const target = new THREE.Vector3(0, 1.1, 0);
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
    view.r = THREE.MathUtils.clamp(view.r * (1 + Math.sign(e.deltaY) * 0.09), 18, 160);
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

const d = derive();
let t0 = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - t0) / 1000); t0 = now;
  if (view.auto && !view.drag) view.theta += dt * 0.18;
  const s = Math.sin(view.phi);
  camera.position.set(view.r * s * Math.sin(view.theta),
                      target.y + view.r * Math.cos(view.phi),
                      view.r * s * Math.cos(view.theta));
  camera.lookAt(target);

  options.update(d, now / 1000);
  (composer || renderer).render(scene, camera);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
