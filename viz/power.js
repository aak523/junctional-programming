/* The power contract, alone.

   The same object the globe uses (power3d.js), in the same key (theme3d.js), lit the
   same way — on an empty page with nothing around it. Drag to orbit, scroll to zoom.

   The page has no chrome; everything is a URL parameter:
     ?theme=light|dark   the key
     ?state=<preset>     signed · soon · live · dead · expiring · late
     ?spin=0             stop the auto-orbit
*/
import * as THREE from 'three';
import { EffectComposer } from './vendor/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from './vendor/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from './vendor/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from './vendor/jsm/postprocessing/OutputPass.js';
import { Power, POWER_TERM } from './power3d.js';
import { useTheme } from './theme3d.js';

const Q = new URLSearchParams(location.search);
const { LIGHT, T, metal } = useTheme();

/* The real record is { mw, start, end, site } — the signing month is not kept, so the
   bench supplies it: `start` is `signed + lead`, where lead comes off the site's
   pre-drawn queue (us 3–8, eu 4–9, ap 2–6) and is told to you at signing. `end` is
   derived here the way world.py derives it: start + POWER_TERM.
   ownedH / ownedN are the thousands of GPUs at the site this contract has to power. */
const STATES = {
  // just signed in eu on the long end of its queue: nine months of nothing, and the
  // dearest power in the game waiting at the other end of them
  signed:   { site: 'eu', mw: 8,  signed: 2,  lead: 9, month: 2,  ownedH: 0, ownedN: 0 },
  // ap's queue is short — signed last month, live next month
  soon:     { site: 'ap', mw: 12, signed: 5,  lead: 2, month: 6,  ownedH: 0, ownedN: 0 },
  // energised and nearly all of it carrying load, N powered first
  live:     { site: 'us', mw: 14, signed: 2,  lead: 4, month: 13, ownedH: 5, ownedN: 4 },
  // energised with nothing to power: the whole bus is dead cost, charged anyway
  dead:     { site: 'eu', mw: 10, signed: 0,  lead: 4, month: 9,  ownedH: 0, ownedN: 0 },
  // a starting contract: us 10 MW, months -4..19, in its last month, with 7k gen H on
  // site and nothing drawn to replace it — four bare months to the horizon
  expiring: { site: 'us', mw: 10, signed: -4, lead: 0, month: 19, ownedH: 7, ownedN: 0 },
  // signed too late: energised at 21, so 21 of its 24 months are past the horizon and
  // can only be settled, and most of the megawatts have nothing to carry
  late:     { site: 'ap', mw: 20, signed: 17, lead: 4, month: 22, ownedH: 6, ownedN: 2 },
};
const S = STATES[Q.get('state')] || STATES.live;
const state = { ...S, start: S.signed + S.lead, end: S.signed + S.lead + POWER_TERM };

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

const power = new Power({ theme: T, color: T.site[state.site], metal });
scene.add(power.group);

// ---------------------------------------------------------------- orbit
const view = { r: 37, theta: 0.62, phi: 0.90, auto: Q.get('spin') !== '0', drag: 0 };
const target = new THREE.Vector3(0, 2.2, 0);
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

  power.update(state, now / 1000);
  (composer || renderer).render(scene, camera);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
