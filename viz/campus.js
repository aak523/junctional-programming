/* The campus object, on the bench.

   Same object the globe uses (campus3d.js), same key (theme3d.js), lit the same way —
   only here it stands on a flat ground with the state exposed on sliders, so the geometry
   can be worked on without replaying a game to reach an interesting month. */
import * as THREE from 'three';
import { EffectComposer } from './vendor/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from './vendor/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from './vendor/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from './vendor/jsm/postprocessing/OutputPass.js';
import { Campus, PAD_R, PAD_TOP, FLOOR_H, KH, STATUS } from './campus3d.js';
import { useTheme } from './theme3d.js';

const { key: THEME, LIGHT, T, css, metal } = useTheme();
const SITE_COLOR = T.site;
const POWER_MW = { H: 1.4, N: 1.6 };      // MW per thousand GPUs, from world.py
const COMPUTE = { H: 1, N: 2 };           // kH per thousand

document.getElementById('theme').addEventListener('click', () => {
  const q = new URLSearchParams(location.search);
  q.set('theme', LIGHT ? 'dark' : 'light');
  location.search = q.toString();
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
const fill = new THREE.DirectionalLight(T.fillHue, T.fillLight);
fill.position.set(-30, 14, -24);
scene.add(fill);

let composer = null;
if (!LIGHT) {
  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(new UnrealBloomPass(new THREE.Vector2(1, 1), 0.34, 0.5, 0.9));
  composer.addPass(new OutputPass());
}
let bloomOn = !LIGHT;      // the globe's own setting; off shows the bare geometry

// ground: the patch of world the pad would be standing on
const ground = new THREE.Group();
scene.add(ground);
{
  const disc = new THREE.Mesh(
    new THREE.CircleGeometry(32, 96),
    new THREE.MeshStandardMaterial({ color: T.land, roughness: 0.95, metalness: 0 })
  );
  disc.rotation.x = -Math.PI / 2;
  disc.position.y = -0.02;
  disc.receiveShadow = true;
  ground.add(disc);

  const pts = [];
  for (let r = 10; r <= 30; r += 10)
    for (let i = 0; i < 128; i++) {
      const a = (i / 128) * Math.PI * 2, b = ((i + 1) / 128) * Math.PI * 2;
      pts.push(Math.sin(a) * r, 0, Math.cos(a) * r, Math.sin(b) * r, 0, Math.cos(b) * r);
    }
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    pts.push(Math.sin(a) * 9, 0, Math.cos(a) * 9, Math.sin(a) * 31, 0, Math.cos(a) * 31);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  ground.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({
    color: T.graticule, transparent: true, opacity: LIGHT ? 0.3 : 0.16 })));
}

// a ruler, so the encodings are readable as lengths: 1 kH of tower, 10 MW of substation
const ruler = new THREE.Group();
ruler.visible = false;
scene.add(ruler);
{
  const ink = new THREE.LineBasicMaterial({ color: T.tick, transparent: true, opacity: 0.55 });
  const pts = [];
  const X = PAD_R + 3.4;
  pts.push(X, PAD_TOP, 0, X, PAD_TOP + FLOOR_H * 6, 0);          // the tower scale
  for (let i = 0; i <= 6; i++) {
    const y = PAD_TOP + FLOOR_H * i;
    pts.push(X - 0.9, y, 0, X + 0.9, y, 0);
  }
  const Z = -(PAD_R + 6.2);
  pts.push(X, PAD_TOP, Z, X, PAD_TOP + 0.22 * 40, Z);            // the megawatt scale
  for (let i = 0; i <= 4; i++) {
    const y = PAD_TOP + 0.22 * 10 * i;
    pts.push(X - 0.9, y, Z, X + 0.9, y, Z);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  ruler.add(new THREE.LineSegments(g, ink));
}

// ---------------------------------------------------------------- the object
let campus = null;
function build(site) {
  if (campus) scene.remove(campus.group);
  campus = new Campus({ theme: T, color: SITE_COLOR[site], slots: 16, metal });
  scene.add(campus.group);
  document.getElementById('tag').textContent = site;
  applyParts();
}

// ---------------------------------------------------------------- orbit
const view = { r: 42, theta: 0.72, phi: 1.02, target: new THREE.Vector3(0, 4.5, 0), auto: true, drag: 0 };
const HOME = { r: 42, theta: 0.72, phi: 1.02 };
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

// ---------------------------------------------------------------- state
const S = { site: 'us', ownedH: 6, ownedN: 0, mw: 10, mwPending: 0, reserved: 2, option: 0, spot: 0, demand: 3.5 };

/* powered follows world.py exactly: gen N takes the megawatts first, gen H gets the rest. */
function derive() {
  const poweredN = Math.min(S.ownedN, S.mw / POWER_MW.N);
  const poweredH = Math.min(S.ownedH, (S.mw - poweredN * POWER_MW.N) / POWER_MW.H);
  const own = poweredN * COMPUTE.N + poweredH * COMPUTE.H;
  const capacity = own + S.reserved + S.option + S.spot;
  const served = Math.min(S.demand, capacity);
  return {
    ...S, poweredH, poweredN, own, capacity, served,
    training: capacity - served,
    unserved: S.demand - served,
    fleet: S.ownedH * COMPUTE.H + S.ownedN * COMPUTE.N,
    mwNeeded: S.ownedH * POWER_MW.H + S.ownedN * POWER_MW.N,
  };
}

const CONTROLS = [
  { k: 'ownedH', label: 'Owned gen H', min: 0, max: 16, step: 0.5, fmt: v => `${v} k` },
  { k: 'ownedN', label: 'Owned gen N', min: 0, max: 10, step: 0.5, fmt: v => `${v} k` },
  { k: 'mw', label: 'Energised power', min: 0, max: 40, step: 0.5, fmt: v => `${v} MW` },
  { k: 'mwPending', label: 'Power contracted', min: 0, max: 30, step: 0.5, fmt: v => `+${v} MW` },
  { k: 'reserved', label: 'Reserved', min: 0, max: 12, step: 0.5, fmt: v => `${v} kH` },
  { k: 'option', label: 'Option exercised', min: 0, max: 12, step: 0.5, fmt: v => `${v} kH` },
  { k: 'spot', label: 'Spot filled', min: 0, max: 6, step: 0.5, fmt: v => `${v} kH` },
  { k: 'demand', label: 'Inference demand', min: 0, max: 30, step: 0.5, fmt: v => `${v} kH` },
];

function buildControls() {
  const host = document.getElementById('controls');
  host.innerHTML = '';
  for (const c of CONTROLS) {
    const d = document.createElement('div');
    d.className = 'ctl';
    d.innerHTML = `<div class="k"><span>${c.label}</span><u class="${S[c.k] ? '' : 'off'}">${c.fmt(S[c.k])}</u></div>
      <input type="range" min="${c.min}" max="${c.max}" step="${c.step}" value="${S[c.k]}" aria-label="${c.label}">`;
    d.querySelector('input').addEventListener('input', e => {
      S[c.k] = +e.target.value;
      const u = d.querySelector('u');
      u.textContent = c.fmt(S[c.k]);
      u.className = S[c.k] ? '' : 'off';
      readout();
    });
    host.appendChild(d);
  }
}

const PRESETS = {
  'Empty site': { ownedH: 0, ownedN: 0, mw: 0, mwPending: 8, reserved: 0, option: 0, spot: 0, demand: 1.2 },
  'Month 0 · us': { ownedH: 6, ownedN: 0, mw: 10, mwPending: 0, reserved: 2, option: 0, spot: 0, demand: 3 },
  'Stranded': { ownedH: 14, ownedN: 0, mw: 8.4, mwPending: 12, reserved: 0, option: 0, spot: 0, demand: 5 },
  'Unserved': { ownedH: 3, ownedN: 0, mw: 4.2, mwPending: 0, reserved: 0, option: 0, spot: 1, demand: 11 },
  'Gen N fleet': { ownedH: 2, ownedN: 7, mw: 14, mwPending: 0, reserved: 0, option: 0, spot: 0, demand: 8 },
  'Everything on': { ownedH: 8, ownedN: 4, mw: 18, mwPending: 9, reserved: 5, option: 3.5, spot: 4.5, demand: 14 },
};

function buildPresets() {
  const host = document.getElementById('presets');
  host.innerHTML = '';
  for (const name in PRESETS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = name;
    b.addEventListener('click', () => { Object.assign(S, PRESETS[name]); buildControls(); readout(); });
    host.appendChild(b);
  }
}

// ---------------------------------------------------------------- parts
const PARTS = [
  { k: 'pad', label: 'Pad & rim', note: 'The site. Radius 8, deck at 1.9.', sw: () => css(T.pad) },
  { k: 'towers', label: 'Towers', note: '3.0 units of height per kH. Lit = powered.', sw: () => css(SITE_COLOR[S.site]) },
  { k: 'crowns', label: 'Crowns', note: 'Gen N caps — 2 kH per thousand units.', sw: () => css(T.crown) },
  { k: 'slabs', label: 'Slabs', note: 'Reserved on the left, option on the right.', sw: () => css(STATUS.warning) },
  { k: 'spots', label: 'Spot pillars', note: 'One per 0.9 kH filled, flickering.', sw: () => css(SITE_COLOR[S.site]) },
  { k: 'sub', label: 'Substation', note: 'Energised MW, with a ghost for contracted.', sw: () => css(T.sub) },
  { k: 'bar', label: 'Ground bar', note: 'Served | training | unserved, tick at demand.', sw: () => css(STATUS.critical) },
];
const partOn = Object.fromEntries(PARTS.map(p => [p.k, true]));

function buildParts() {
  const host = document.getElementById('parts');
  host.innerHTML = '';
  for (const p of PARTS) {
    const d = document.createElement('div');
    d.className = 'part';
    d.dataset.on = partOn[p.k] ? '1' : '0';
    d.innerHTML = `<b class="sw" style="background:${p.sw()}"></b>
      <div class="t"><b>${p.label}</b><span>${p.note}</span></div>
      <div class="eye">${partOn[p.k] ? 'shown' : 'hidden'}</div>`;
    d.addEventListener('click', () => {
      partOn[p.k] = !partOn[p.k];
      d.dataset.on = partOn[p.k] ? '1' : '0';
      d.querySelector('.eye').textContent = partOn[p.k] ? 'shown' : 'hidden';
    });
    host.appendChild(d);
  }
}

/* update() decides what is visible from the state; these overrides run after it,
   so hiding a part is a view, not a change to the object. */
function applyParts() {
  if (!campus) return;
  campus.pad.visible = partOn.pad;
  campus.rim.visible = partOn.pad;
  for (const t of campus.towers) {
    if (!partOn.towers) t.visible = false;
    t.userData.crown.visible = t.userData.crown.visible && partOn.crowns;
  }
  if (!partOn.slabs) { campus.resSlab.visible = false; campus.optSlab.visible = false; }
  if (!partOn.spots) for (const p of campus.spots) p.visible = false;
  if (!partOn.sub) { campus.sub.visible = false; campus.ghost.visible = false; }
  campus.bar.visible = partOn.bar;
}

// ---------------------------------------------------------------- readout
function readout() {
  const d = derive();
  const head = d.mw - d.mwNeeded;
  const tiles = [
    { k: 'Live compute', v: d.own.toFixed(1), s: 'kH powered' },
    { k: 'Capacity', v: d.capacity.toFixed(1), s: 'kH all in' },
    { k: 'Fleet', v: d.fleet.toFixed(1), s: 'kH owned' },
    { k: 'Dark', v: (d.fleet - d.own).toFixed(1), s: 'kH unpowered', cls: d.fleet - d.own > 0.05 ? 'warn' : '' },
    { k: 'Power', v: head >= 0 ? `+${head.toFixed(1)}` : head.toFixed(1), s: 'MW headroom',
      cls: head < 0 ? 'warn' : '' },
    { k: 'Training', v: d.training.toFixed(1), s: 'kH spare' },
    { k: 'Unserved', v: d.unserved.toFixed(1), s: '$' + (d.unserved * 4).toFixed(0) + 'M a month',
      cls: d.unserved > 0.01 ? 'bad' : '' },
    { k: 'Towers', v: `${Math.ceil(d.ownedH - 1e-6) + Math.ceil(d.ownedN - 1e-6)}/${campus ? campus.towers.length : 16}`,
      s: 'pads in use' },
  ];
  document.getElementById('tiles').innerHTML = tiles.map(t =>
    `<div class="tile"><div class="k">${t.k}</div><div class="v ${t.cls || ''}">${t.v}</div>
     <div class="s">${t.s}</div></div>`).join('');
}

// ---------------------------------------------------------------- chrome
const toggle = (id, on, fn) => {
  const b = document.getElementById(id);
  b.setAttribute('aria-pressed', String(on));
  b.addEventListener('click', () => {
    const next = b.getAttribute('aria-pressed') !== 'true';
    b.setAttribute('aria-pressed', String(next));
    fn(next);
  });
};
toggle('spin', true, v => { view.auto = v; });
toggle('ground', true, v => { ground.visible = v; });
toggle('ruler', false, v => { ruler.visible = v; });
toggle('bloom', !LIGHT, v => { bloomOn = v && !LIGHT; });
document.getElementById('front').addEventListener('click', () => { view.theta = 0; view.phi = 1.38; view.auto = false; sync(); });
document.getElementById('top').addEventListener('click', () => { view.phi = 0.16; view.auto = false; sync(); });
document.getElementById('reset').addEventListener('click', () => { Object.assign(view, HOME); view.auto = true; sync(); });
const sync = () => document.getElementById('spin').setAttribute('aria-pressed', String(view.auto));
document.getElementById('ev-good').addEventListener('click', () => campus.burst(STATUS.good));
document.getElementById('ev-bad').addEventListener('click', () => campus.burst(STATUS.critical));

{
  const host = document.getElementById('site');
  for (const s of ['us', 'eu', 'ap']) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = s.toUpperCase();
    b.setAttribute('aria-pressed', String(S.site === s));
    b.addEventListener('click', () => {
      S.site = s;
      host.querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', String(x.textContent.toLowerCase() === s)));
      build(s); buildParts();
    });
    host.appendChild(b);
  }
}

// ---------------------------------------------------------------- loop
function resize() {
  const w = stage.clientWidth, h = stage.clientHeight;
  renderer.setSize(w, h, false);
  composer?.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(stage);

let t0 = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - t0) / 1000); t0 = now;
  if (view.auto && !view.drag) view.theta += dt * 0.18;
  const s = Math.sin(view.phi);
  camera.position.set(view.target.x + view.r * s * Math.sin(view.theta),
                      view.target.y + view.r * Math.cos(view.phi),
                      view.target.z + view.r * s * Math.cos(view.theta));
  camera.lookAt(view.target);

  campus.update(derive(), now / 1000);
  applyParts();
  ((bloomOn && composer) || renderer).render(scene, camera);
  requestAnimationFrame(frame);
}

build(S.site);
buildControls();
buildPresets();
buildParts();
readout();
resize();
requestAnimationFrame(frame);
