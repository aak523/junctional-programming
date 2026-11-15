/* The spot dial, alone.

   The same object the globe uses (spot3d.js), in the same key (theme3d.js), lit the same
   way — on an empty page with nothing around it. Drag to orbit, scroll to zoom.

   The page has no chrome; everything is a URL parameter:
     ?theme=light|dark   the key
     ?state=<preset>     shut · filled · starved · spike · export · stacked
     ?truth=0            hide the ceiling again, and read the month the agent's way
     ?spin=0             stop the auto-orbit
*/
import * as THREE from 'three';
import { EffectComposer } from './vendor/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from './vendor/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from './vendor/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from './vendor/jsm/postprocessing/OutputPass.js';
import { Spot, capOf, priceOf } from './spot3d.js';
import { useTheme } from './theme3d.js';

const Q = new URLSearchParams(location.search);
const { LIGHT, T, metal } = useTheme();

/* The presets hold only what the world holds: the site, the standing level, the month's
   regime, whether a rival is spiking, whether export controls are live, and the two
   exogenous numbers behind the price (the contract index and this month's spot noise).
   cap and price are derived below exactly as world.py derives them. */
const STATES = {
  // the dial at zero: a posted price, a valve shut, nothing delivered
  shut:    { site: 'us', level: 0,   regime: 'loose', spike: false, exportActive: false, cindex: 1.60, noise: 1.00 },
  // a modest request, filled in full: loose us ceiling 5.0 kH
  filled:  { site: 'us', level: 1.8, regime: 'loose', spike: false, exportActive: false, cindex: 1.55, noise: 0.92 },
  // a big standing request left over into a tight month: ceiling 1.5 kH, price up 1.8x
  starved: { site: 'us', level: 6.0, regime: 'tight', spike: false, exportActive: false, cindex: 2.10, noise: 1.15 },
  // a rival spike: half the ceiling, 1.5x the price. announced in the news, so no surprise
  spike:   { site: 'eu', level: 3.0, regime: 'loose', spike: true,  exportActive: false, cindex: 1.80, noise: 1.05 },
  // export controls: 0.6x the ceiling for six months, price untouched
  export:  { site: 'us', level: 4.0, regime: 'loose', spike: false, exportActive: true,  cindex: 1.70, noise: 1.10 },
  // the worst case, stacked: ap, tight, spiking, controlled. 0.5 x 0.5 x 0.6 = 0.15 kH
  stacked: { site: 'ap', level: 5.0, regime: 'tight', spike: true,  exportActive: true,  cindex: 2.60, noise: 1.20 },
};
const S = STATES[Q.get('state')] || STATES.starved;

// world.py: cap = SPOT_CAP[regime][site] x (0.5 if spike) x (0.6 if export controls),
// price = cindex x SPOT_MULT[regime] x spot_noise x (1.5 if spike) x SITE_PRICE[site]
const d = {
  ...S,
  cap: capOf(S.site, S.regime, S.spike, S.exportActive),
  price: priceOf(S.cindex, S.regime, S.noise, S.spike, S.site),
  truth: Q.get('truth') !== '0',
};

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

const spot = new Spot({ theme: T, color: T.site[d.site], metal });
scene.add(spot.group);
// the bench shows one standing month, so let the easing settle before the first frame
for (let i = 0; i < 120; i++) spot.update(d, 0);

// ---------------------------------------------------------------- orbit
const view = { r: 23, theta: 0.52, phi: 1.08, auto: Q.get('spin') !== '0', drag: 0 };
const target = new THREE.Vector3(-1.4, 3.6, 0.0);
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
  camera.position.set(view.r * s * Math.sin(view.theta),
                      target.y + view.r * Math.cos(view.phi),
                      view.r * s * Math.cos(view.theta));
  camera.lookAt(target);

  spot.update(d, now / 1000);
  (composer || renderer).render(scene, camera);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
