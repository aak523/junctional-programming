/* The broker object, alone.

   The same object a globe would use (broker3d.js), in the same key (theme3d.js), lit the
   same way — on an empty page with nothing around it. Drag to orbit, scroll to zoom.

   The page has no chrome; everything is a URL parameter:
     ?theme=light|dark   the key            ?broker=A|B   Dubai at 1.10x, Panama at 1.25x
     ?state=<preset>     idle · pending · delivered · cancelled · reliable · decayed
     ?truth=1            show the hidden reliability: the cast dice and the threshold line
     ?spin=0             stop the auto-orbit
*/
import * as THREE from 'three';
import { EffectComposer } from './vendor/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from './vendor/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from './vendor/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from './vendor/jsm/postprocessing/OutputPass.js';
import { Broker, Q_HI, Q_LO } from './broker3d.js';
import { useTheme } from './theme3d.js';

const Q = new URLSearchParams(location.search);
const { LIGHT, T, metal } = useTheme();
const BROKERS = { A: 1.10, B: 1.25 };     // markup over list, from world.py
const GPU_PRICE = { H: 25.0, N: 40.0 };   // $M per thousand GPUs

/* The presets. Each is what the player did (a list of orders, with the month each was
   placed) plus the hidden state of this broker — reliability, the decay month, and the
   pre-drawn dice. `closed` means we are looking at the month after its end_month has
   run, so the orders placed last month have just been stamped. Everything else is
   derived below exactly the way world.py derives it. */
const STATES = {
  // nothing has ever been ordered here: an empty yard and a blank rail
  idle: {
    month: 3, closed: false, reliable: true, decay: null, orders: [],
    u: [0.21, 0.64, 0.33, 0.49, 0.77],
  },
  // one order in the hold bay resolving at the end of this month, one just placed
  pending: {
    month: 5, closed: false, reliable: true, decay: null,
    orders: [{ qty: 2.0, gen: 'H', site: 'eu', placed: 4 },
             { qty: 1.5, gen: 'H', site: 'us', placed: 5 }],
    u: [0.18, 0.44],
  },
  // the stamp came down and the whole order went out the gate
  delivered: {
    month: 6, closed: true, reliable: true, decay: null,
    orders: [{ qty: 1.0, gen: 'H', site: 'us', placed: 2 },
             { qty: 2.0, gen: 'H', site: 'ap', placed: 4 },
             { qty: 3.0, gen: 'H', site: 'us', placed: 5 }],
    u: [0.26, 0.11, 0.33],
  },
  // and here it voided one: the chute pays 80% back, the red tail is the 20% you ate.
  // A fresh 4k order the same month has the monthly cap exactly full.
  cancelled: {
    month: 7, closed: true, reliable: false, decay: null,
    orders: [{ qty: 1.0, gen: 'H', site: 'us', placed: 2 },
             { qty: 2.5, gen: 'H', site: 'eu', placed: 5 },
             { qty: 4.0, gen: 'H', site: 'ap', placed: 6 },
             { qty: 4.0, gen: 'H', site: 'us', placed: 7 }],
    u: [0.09, 0.62, 0.71, 0.30],
  },
  // a broker that has been good all year: a long rail of green caps
  reliable: {
    month: 19, closed: true, reliable: true, decay: null,
    orders: [2, 4, 5, 7, 8, 10, 12, 13, 15, 16, 18].map((placed, i) => ({
      qty: [1, 2, 2.5, 1.5, 3, 4, 2, 3.5, 2, 2.5, 3][i],
      gen: placed >= 9 ? 'N' : 'H', site: ['us', 'eu', 'ap'][i % 3], placed })),
    u: [0.14, 0.52, 0.28, 0.61, 0.07, 0.44, 0.83, 0.19, 0.36, 0.73, 0.23],
  },
  // the same track record, but the broker silently turned at month 11: the dice never
  // changed, the threshold dropped under them. Worth seeing with and without ?truth=1.
  decayed: {
    month: 19, closed: true, reliable: true, decay: 11,
    orders: [2, 4, 5, 7, 8, 10, 12, 13, 15, 16, 18].map((placed, i) => ({
      qty: [1, 2, 2.5, 1.5, 3, 4, 2, 3.5, 2, 2.5, 3][i],
      gen: placed >= 9 ? 'N' : 'H', site: ['us', 'eu', 'ap'][i % 3], placed })),
    u: [0.14, 0.52, 0.28, 0.61, 0.07, 0.44, 0.83, 0.19, 0.36, 0.73, 0.23],
  },
};
const S = STATES[Q.get('state')] || STATES.decayed;
const b = Q.get('broker') === 'B' ? 'B' : 'A';
const markup = BROKERS[b];

// world.py: broker_q(b, k) — the reliable rate until the decay month, the low one after.
// The comparison uses the resolution month, not the month the order was placed.
const q = k => (!S.reliable || (S.decay !== null && k >= S.decay)) ? Q_LO : Q_HI;

/* What the object is showing. An order placed in month p sits in the intake bay that
   month, in the hold bay through p+1, and is stamped at the end of p+1 — delivered in
   full if its pre-drawn die is under the threshold, else cancelled with 80% refunded. */
function derive() {
  const o = (x, n) => ({ qty: x.qty, site: x.site, n,
    paid: x.qty * GPU_PRICE[x.gen] * markup,
    month: x.placed + 1, delivered: S.u[n] < q(x.placed + 1) });
  const all = S.orders.map(o);
  const done = all.filter(x => x.month < S.month || (S.closed && x.month === S.month));
  return {
    month: S.month,
    bought: S.orders.reduce((s, x, i) => s + (x.placed === S.month ? all[i].qty : 0), 0),
    intake: all.filter((x, i) => S.orders[i].placed === S.month),
    hold: S.closed ? [] : all.filter(x => x.month === S.month),
    resolved: S.closed ? all.filter(x => x.month === S.month) : [],
    record: done,
    truth: Q.get('truth') === '1',
    reliable: S.reliable, decay: S.decay, u: S.u,
  };
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

const broker = new Broker({ theme: T, metal, markup });
scene.add(broker.group);

// ---------------------------------------------------------------- orbit
const view = { r: 27, theta: 0.0, phi: 0.95, auto: Q.get('spin') !== '0', drag: 0 };
const target = new THREE.Vector3(0, 2.2, 0.6);
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

const D = derive();
let t0 = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - t0) / 1000); t0 = now;
  if (view.auto && !view.drag) view.theta += dt * 0.18;
  const s = Math.sin(view.phi);
  camera.position.set(view.r * s * Math.sin(view.theta),
                      target.y + view.r * Math.cos(view.phi),
                      view.r * s * Math.cos(view.theta));
  camera.lookAt(target);

  broker.update(D, now / 1000);
  (composer || renderer).render(scene, camera);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
