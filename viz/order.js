/* One order in transit, alone.

   The same object the globe flies down its shipping lanes (order3d.js), in the same key
   (theme3d.js), lit the same way — on an empty page with a lane to ride, a dock at one
   end and a pad at the other. Drag to orbit, scroll to zoom.

   The page has no chrome; everything is a URL parameter:
     ?theme=light|dark   the key
     ?state=<preset>     start · fresh · eligible · half · stuck · inflight ·
                         delivered · cancelled · landed
     ?spin=0             stop the auto-orbit
*/
import * as THREE from 'three';
import { EffectComposer } from './vendor/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from './vendor/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from './vendor/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from './vendor/jsm/postprocessing/OutputPass.js';
import { Order, deckLength } from './order3d.js';
import { useTheme } from './theme3d.js';

const Q = new URLSearchParams(location.search);
const { LIGHT, T, metal } = useTheme();
const GPU_PRICE = { H: 25, N: 40 };                      // $M per thousand, from world.py
const MARKUP = { vendor: 1.0, A: 1.10, B: 1.25 };        // broker markups on list

// The order records. `paid` is not written out: world.py derives it at order time as
// qty x list price x the source's markup, so the bench derives it the same way. `month`
// is the clock the object is read against, and may be fractional the way world3d.js
// interpolates between months.
const STATES = {
  // order #1 of every game: 4k gen H to us, placed in month -2, eligible from month 0
  start:     { src: 'vendor', gen: 'H', qty: 4,  left: 4,  placed: -2, month: 0,    site: 'us', drain: 0 },
  fresh:     { src: 'vendor', gen: 'H', qty: 12, left: 12, placed: 6,  month: 6.6,  site: 'eu', drain: 0 },
  eligible:  { src: 'vendor', gen: 'H', qty: 12, left: 12, placed: 6,  month: 8.3,  site: 'eu', drain: 0 },
  half:      { src: 'vendor', gen: 'N', qty: 12, left: 5.6, placed: 6, month: 10.4, site: 'ap', drain: 2.4 },
  stuck:     { src: 'vendor', gen: 'H', qty: 30, left: 24, placed: 3,  month: 10.2, site: 'us', drain: 0 },
  landed:    { src: 'vendor', gen: 'N', qty: 8,  left: 0,  placed: 9,  month: 14,   site: 'us' },
  inflight:  { src: 'A', gen: 'N', qty: 4,   left: 4, placed: 12, month: 12.55, site: 'eu' },
  delivered: { src: 'A', gen: 'N', qty: 4,   left: 0, placed: 12, month: 13, site: 'eu', delivered: true },
  cancelled: { src: 'B', gen: 'N', qty: 3.5, left: 0, placed: 12, month: 13, site: 'ap', cancelled: true },
};
const S = STATES[Q.get('state')] || STATES.half;
const paid = S.qty * GPU_PRICE[S.gen] * MARKUP[S.src];
const d = { ...S, paid };

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
Object.assign(key.shadow.camera, { left: -34, right: 34, top: 34, bottom: -34, near: 1, far: 160 });
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

// ---------------------------------------------------------------- the lane, the dock, the pad
// Scaffolding only: the globe owns all three. A lifted arc, so the object has a curve to
// ride, with the source at u = 0 and the destination site at u = 1.
const color = T.site[S.site] ?? T.site.us;
const A = new THREE.Vector3(-21, 0, 0), B = new THREE.Vector3(21, 0, 0);
const lane = new THREE.QuadraticBezierCurve3(A, new THREE.Vector3(0, 7, 0), B);
scene.add(new THREE.Mesh(
  new THREE.TubeGeometry(lane, 128, 0.07, 6, false),
  new THREE.MeshBasicMaterial({ color, transparent: true, opacity: LIGHT ? 0.3 : 0.11 })));

const padMat = new THREE.MeshStandardMaterial({ color: T.pad, roughness: 0.92, metalness: metal(0.1) });
// both stations lie square to the lane, so an order parked on one sits level with it
function onLane(obj, u, drop) {
  const p = lane.getPointAt(u), t = lane.getTangentAt(u).normalize();
  const side = t.clone().cross(new THREE.Vector3(0, 1, 0)).normalize();
  const up = side.clone().cross(t).normalize();
  obj.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(t, up, side));
  obj.position.copy(p).addScaledVector(up, drop);
}
const dock = new THREE.Mesh(new THREE.CylinderGeometry(2.6, 3.0, 1.1, 6), padMat);
onLane(dock, 0.01, -1.4);
dock.translateX(-2.2);                      // behind the start, clear of a parked order
dock.receiveShadow = true;
scene.add(dock);
const pad = new THREE.Mesh(new THREE.CylinderGeometry(4.2, 4.2, 0.5, 48), padMat);
onLane(pad, 0.995, -0.9);
pad.receiveShadow = true;
scene.add(pad);
for (const m of [dock, pad]) {
  const e = new THREE.LineSegments(new THREE.EdgesGeometry(m.geometry),
    new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.5 }));
  e.position.copy(m.position);
  e.quaternion.copy(m.quaternion);
  scene.add(e);
}

const order = new Order({ theme: T, color, metal, curve: lane });
scene.add(order.group);

// ---------------------------------------------------------------- orbit
// far enough back that the whole consignment and both ends of the lane stay in frame
const view = { r: 22 + deckLength(S.qty) * 1.8, theta: 0.24, phi: 1.16, auto: Q.get('spin') !== '0', drag: 0 };
const target = new THREE.Vector3(0, 3, 0);
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
    view.r = THREE.MathUtils.clamp(view.r * (1 + Math.sign(e.deltaY) * 0.09), 10, 150);
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

const AHEAD = B.clone().setY(1.2);          // the pad it is heading for
const ahead = new THREE.Vector3();
const look = new THREE.Vector3(0, 3.2, 0);
let t0 = performance.now(), first = true;
function frame(now) {
  const dt = Math.min(0.05, (now - t0) / 1000); t0 = now;
  order.update(d, now / 1000);

  // the camera leans toward the consignment but keeps the dock it left and the pad it is
  // heading for in frame, so the distance still to run stays readable
  order.deck.getWorldPosition(target);        // the middle of the consignment, not its head
  ahead.subVectors(AHEAD, target);            // and a fixed lean down the lane, the way it is
  target.addScaledVector(ahead, Math.min(0.4, 9 / Math.max(1, ahead.length())));   // going
  look.lerp(target, first ? 1 : 0.08);
  first = false;

  if (view.auto && !view.drag) view.theta += dt * 0.18;
  const s = Math.sin(view.phi);
  camera.position.set(look.x + view.r * s * Math.sin(view.theta),
                      look.y + view.r * Math.cos(view.phi),
                      look.z + view.r * s * Math.cos(view.theta));
  camera.lookAt(look);

  (composer || renderer).render(scene, camera);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
