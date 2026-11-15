/* The GPU generation object, alone.

   The same object the globe uses (gen3d.js), in the same key (theme3d.js), lit the same
   way — on an empty page with nothing around it. One class, built twice: gen H on the
   left, gen N on the right, both looking at the same month, so the whole spec difference
   (half a rack against a full one, the same riser, a shorter cage) is one glance.
   Drag to orbit, scroll to zoom.

   The page has no chrome; everything is a URL parameter:
     ?theme=light|dark   the key          ?gen=H|N       one generation alone, centred
     ?state=<preset>     early · export · last · launch · after · late
                         and the per-generation shots h-early · h-launch · h-late
                                                      n-pre  · n-launch · n-late
     ?month=<0..24>      override the month — fractions are fine, the formulas are smooth
     ?sweep=1            run the month from 0 to 24 on a loop, to watch the mark decay
     ?launch=<n>         move the gen N launch month (world.py draws it from 11..18)
     ?spin=0             stop the auto-orbit
*/
import * as THREE from 'three';
import { EffectComposer } from './vendor/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from './vendor/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from './vendor/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from './vendor/jsm/postprocessing/OutputPass.js';
import { Gen, PAD_R } from './gen3d.js';
import { useTheme } from './theme3d.js';

const Q = new URLSearchParams(location.search);
const { LIGHT, T, metal } = useTheme();

// The state is just the month and the world's two hidden dates; price, mark, tide line
// and allocation are all derived inside the object from world.py's formulas. Launch 13
// is the middle of LAUNCH_RANGE = (11, 18).
const STATES = {
  early:      { month: 2,  launch: 13 },                     // H at full value · N does not exist
  export:     { month: 7,  launch: 13, exportActive: true }, // the clamp bites H's gate, not N's
  last:       { month: 12, launch: 13, regime: 'tight' },     // H's last month on sale, tight supply
  launch:     { month: 13, launch: 13 },                     // the 40% cliff: H sealed, N opens
  after:      { month: 17, launch: 13 },                     // H is a sealed pallet losing value
  late:       { month: 23, launch: 13, regime: 'tight' },     // H near write-off · N marked down
  'h-early':  { month: 2,  launch: 13, gen: 'H' },
  'h-launch': { month: 13, launch: 13, gen: 'H' },
  'h-late':   { month: 23, launch: 13, gen: 'H' },
  'n-pre':    { month: 9,  launch: 13, gen: 'N' },
  'n-launch': { month: 13, launch: 13, gen: 'N' },
  'n-late':   { month: 23, launch: 13, gen: 'N' },
};
const S = { regime: 'loose', exportActive: false, ...(STATES[Q.get('state')] || STATES.launch) };
if (Q.has('launch')) S.launch = +Q.get('launch');
if (Q.has('month')) S.month = +Q.get('month');
if (Q.has('gen')) S.gen = Q.get('gen') === 'N' ? 'N' : 'H';
const SWEEP = Q.get('sweep') === '1';

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

// one class, built twice — unless a single generation was asked for
const gens = (S.gen ? [S.gen] : ['H', 'N']).map((g, i, all) => {
  const o = new Gen({ theme: T, gen: g, metal });
  o.group.position.x = all.length === 1 ? 0 : (i === 0 ? -1 : 1) * (PAD_R + 1.2);
  scene.add(o.group);
  return o;
});

// ---------------------------------------------------------------- orbit
const view = { r: S.gen ? 19 : 31, theta: 0.52, phi: 1.04, auto: Q.get('spin') !== '0', drag: 0 };
const target = new THREE.Vector3(0, 2.6, 0);
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

let t0 = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - t0) / 1000); t0 = now;
  if (view.auto && !view.drag) view.theta += dt * 0.16;
  const s = Math.sin(view.phi);
  camera.position.set(view.r * s * Math.sin(view.theta),
                      target.y + view.r * Math.cos(view.phi),
                      view.r * s * Math.cos(view.theta));
  camera.lookAt(target);

  const time = now / 1000;
  const month = SWEEP ? (time * 0.9) % 24 : S.month;
  for (const g of gens) g.update({ ...S, month }, time);
  (composer || renderer).render(scene, camera);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
