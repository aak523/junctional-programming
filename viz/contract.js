/* The reserved cloud contract, alone.

   The same object the globe uses (contract3d.js), in the same key (theme3d.js), lit the
   same way — on an empty page with nothing around it. Drag to orbit, scroll to zoom.

   The page has no chrome; everything is a URL parameter:
     ?theme=light|dark   the key
     ?state=<preset>     start · loose12 · late24 · short6 · tight · refused
     ?cap=0              hide the allowance ghost (the cap is hidden state in the game)
     ?spin=0             stop the auto-orbit
*/
import * as THREE from 'three';
import { EffectComposer } from './vendor/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from './vendor/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from './vendor/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from './vendor/jsm/postprocessing/OutputPass.js';
import { Contract } from './contract3d.js';
import { useTheme } from './theme3d.js';

const Q = new URLSearchParams(location.search);
const { LIGHT, T, metal } = useTheme();

// from world.py: a reservation is priced once, at signing, and never again
const TERM_FACTOR = { 6: 1.15, 12: 1.0, 24: 0.9 };
const SITE_PRICE = { us: 1.0, eu: 1.1, ap: 0.95 };

/* Each preset is the record as the player signed it: the month `reserve()` ran, the term,
   the site, that month's contract index, and the ask-vs-fill pair. `cap` is what the site
   had left of RESERVE_CAP[regime][site] that month — hidden state in the game, so the
   bench draws it as a ghost. Everything else is derived below exactly as world.py does. */
const STATES = {
  // the lab's starting contract: 2.0 kH in us at $2.000, active months 0..4. Its price is
  // written into World.__init__, not derived from the index, so it is given here.
  start:   { signed: -8, months: 12, site: 'us', price: 2.0, ask: 2.0, got: 2.0, cap: 2.0, month: 2 },
  // a 12-month signed cheap in a loose month, filling the whole us allowance of 4 kH
  loose12: { signed: 3, months: 12, site: 'us', cindex: 1.25, ask: 4.0, got: 4.0, cap: 4.0, month: 7 },
  // 24 months signed in month 18: five months of capacity, nineteen of settlement obligation
  late24:  { signed: 18, months: 24, site: 'eu', cindex: 2.60, ask: 3.0, got: 3.0, cap: 3.0, month: 21 },
  // six months at the premium term factor: short, dear per month, and over quickly
  short6:  { signed: 9, months: 6, site: 'ap', cindex: 1.50, ask: 3.0, got: 3.0, cap: 3.0, month: 12 },
  // a tight month: the same ask of 4 kH fills 1, and nothing says why
  tight:   { signed: 7, months: 12, site: 'us', cindex: 2.10, ask: 4.0, got: 1.0, cap: 1.0, month: 11 },
  // the allowance already spent this month: fills 0, costs an operation anyway
  refused: { signed: 12, months: 6, site: 'ap', cindex: 1.90, ask: 3.0, got: 0.0, cap: 0.0, month: 12 },
};
const S = STATES[Q.get('state')] || STATES.late24;

// price = cindex[t] × TERM_FACTOR[months] × SITE_PRICE[site]; start = t+1; end exclusive
function derive() {
  const price = S.price ?? S.cindex * TERM_FACTOR[S.months] * SITE_PRICE[S.site];
  const start = S.signed + 1;
  return { qty: S.got, price, start, end: start + S.months, site: S.site, month: S.month,
           ask: S.ask, got: S.got, cap: Q.get('cap') === '0' ? null : S.cap };
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

const contract = new Contract({ theme: T, color: T.site[S.site], metal });
scene.add(contract.group);

// ---------------------------------------------------------------- orbit
// frame whatever this state actually spans: a 24-month term signed late runs a long way
// past the end wall, a six-month one barely leaves the deck
const d = derive();
const view = { r: 22, theta: 0.40, phi: 1.02, auto: Q.get('spin') !== '0', drag: 0 };
const target = new THREE.Vector3(0, 4.6, 0);
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
    view.r = THREE.MathUtils.clamp(view.r * (1 + Math.sign(e.deltaY) * 0.09), 14, 150);
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
  camera.position.set(target.x + view.r * s * Math.sin(view.theta),
                      target.y + view.r * Math.cos(view.phi),
                      target.z + view.r * s * Math.cos(view.theta));
  camera.lookAt(target);

  contract.update({ ...d, camera }, now / 1000);
  (composer || renderer).render(scene, camera);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
