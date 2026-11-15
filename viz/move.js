/* The fleet-move object, alone.

   The same object the globe uses (move3d.js), in the same key (theme3d.js), lit the same
   way — on an empty page with nothing around it. Drag to orbit, scroll to zoom.

   The page has no chrome; everything is a URL parameter:
     ?theme=light|dark   the key            ?from=us|eu|ap      who is left short
     ?state=<preset>     depart · transit · arriving · cap · genN · stripped
     ?to=us|eu|ap        where it lands
     ?spin=0             stop the auto-orbit, and freeze the move at the preset's progress
*/
import * as THREE from 'three';
import { EffectComposer } from './vendor/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from './vendor/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from './vendor/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from './vendor/jsm/postprocessing/OutputPass.js';
import { Move, COMPUTE, LIFT } from './move3d.js';
import { useTheme } from './theme3d.js';

const Q = new URLSearchParams(location.search);
const { LIGHT, T, metal } = useTheme();
const MONTH = 16;                         // seconds of replay for the one month in flight

// what the object is showing. `prog` is where in the month the move is; `shortfall` is
// derived the way world.py derives a site's unserved inference: the origin serves only its
// own INF_SHARE of demand out of its own powered compute, so what is left there after the
// move (fromLeft × COMPUTE[gen]) is measured against fromDemand.
const STATES = {
  depart:   { gen: 'H', qty: 1.2, prog: 0.05, movedNow: 1.2, fromLeft: 5.0, fromDemand: 4.0, frm: 'us', to: 'ap' },
  transit:  { gen: 'H', qty: 3.0, prog: 0.47, movedNow: 3.0, fromLeft: 4.0, fromDemand: 3.5, frm: 'us', to: 'eu' },
  arriving: { gen: 'H', qty: 2.0, prog: 0.93, movedNow: 2.0, fromLeft: 4.0, fromDemand: 3.2, frm: 'eu', to: 'ap' },
  cap:      { gen: 'H', qty: 5.0, prog: 0.3,  movedNow: 5.0, fromLeft: 5.0, fromDemand: 4.5, frm: 'us', to: 'eu' },
  genN:     { gen: 'N', qty: 2.5, prog: 0.55, movedNow: 4.0, fromLeft: 2.0, fromDemand: 3.0, frm: 'us', to: 'ap' },
  stripped: { gen: 'H', qty: 4.0, prog: 0.22, movedNow: 4.0, fromLeft: 0.5, fromDemand: 5.0, frm: 'us', to: 'eu' },
};
const S = STATES[Q.get('state')] || STATES.transit;
const RUN = Q.get('spin') !== '0';        // a frozen page is a frozen month, so presets read

let prog = S.prog;
function derive() {
  return { ...S, prog: Math.min(1, prog),
           shortfall: Math.max(0, S.fromDemand - S.fromLeft * COMPUTE[S.gen]) };
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
key.position.set(26, 44, 24);
key.castShadow = true;
key.shadow.mapSize.set(1024, 1024);
Object.assign(key.shadow.camera, { left: -34, right: 34, top: 34, bottom: -34, near: 1, far: 160 });
scene.add(key);
const fill = new THREE.DirectionalLight(T.fillHue, T.fillLight * (LIGHT ? 1 : 2.2));
fill.position.set(-32, 16, -26);
scene.add(fill);
const back = new THREE.DirectionalLight(0xffffff, LIGHT ? 0.1 : 0.35);
back.position.set(-20, 22, 28);
scene.add(back);

let composer = null;
if (!LIGHT) {
  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(new UnrealBloomPass(new THREE.Vector2(1, 1), 0.34, 0.5, 0.9));
  composer.addPass(new OutputPass());
}

const site = (k, dflt) => (['us', 'eu', 'ap'].includes(Q.get(k)) ? Q.get(k) : dflt);
const move = new Move({
  theme: T, metal,
  fromColor: T.site[site('from', S.frm)],
  toColor: T.site[site('to', S.to)],
});
scene.add(move.group);

// ---------------------------------------------------------------- orbit
const view = { r: 41, theta: 0.16, phi: 1.17, auto: RUN, drag: 0 };
const target = new THREE.Vector3(0, LIFT * 0.70, 0);
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
    view.r = THREE.MathUtils.clamp(view.r * (1 + Math.sign(e.deltaY) * 0.09), 18, 200);
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
  if (view.auto && !view.drag) view.theta += dt * 0.14;
  // the month runs out, the move lands, and the next one departs
  if (RUN && (prog += dt / MONTH) > 1.25) prog = 0;
  const s = Math.sin(view.phi);
  camera.position.set(view.r * s * Math.sin(view.theta),
                      target.y + view.r * Math.cos(view.phi),
                      view.r * s * Math.cos(view.theta));
  camera.lookAt(target);

  move.update(derive(), now / 1000);
  (composer || renderer).render(scene, camera);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
