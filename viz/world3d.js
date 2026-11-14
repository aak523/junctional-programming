/* GPU World — 3D replay of one 24-month game.
   Data comes from viz/data/*.json (written by viz/export_run.py). */
import * as THREE from 'three';
import { EffectComposer } from './vendor/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from './vendor/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from './vendor/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from './vendor/jsm/postprocessing/OutputPass.js';

// ---------------------------------------------------------------- palette & layout
const SITE_COLOR = { us: 0x3987e5, eu: 0xd95926, ap: 0x199e70 };
const SITE_NAME  = { us: 'US', eu: 'EU', ap: 'AP' };
const STATUS = { good: 0x0ca30c, warning: 0xfab219, serious: 0xec835a, critical: 0xd03b3b };
const INK = 0xffffff, STEEL = 0x6f6f68;

const SITE_POS = {
  us: new THREE.Vector3(-26, 0, 8),
  eu: new THREE.Vector3(  0, 0,  2),
  ap: new THREE.Vector3( 26, 0, 10),
};
const SRC_POS = {
  vendor: new THREE.Vector3(  0, 0, -54),
  A:      new THREE.Vector3(-36, 0, -42),
  B:      new THREE.Vector3( 36, 0, -44),
};
const SRC_LABEL = { vendor: 'VENDOR', A: 'BROKER A', B: 'BROKER B' };
const SRC_SUB = { vendor: 'list price · allocated queue', A: '1.10x · 2-month confirm', B: '1.25x · 2-month confirm' };

const PAD_R = 11;            // campus platform radius
const KH = 0.40;             // world units per kH on the ground bars
const FLOOR_H = 3.6;         // tower height per kH of compute

// ---------------------------------------------------------------- renderer
const stage = document.getElementById('stage');
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
stage.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0d0d0d);
scene.fog = new THREE.Fog(0x0d0d0d, 120, 310);

const camera = new THREE.PerspectiveCamera(46, innerWidth / innerHeight, 0.5, 900);
camera.position.set(0, 58, 88);

let composer = null;
try {
  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.48, 0.6, 0.82);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
} catch (e) { console.warn('bloom unavailable, falling back to plain render', e); composer = null; }

// ---------------------------------------------------------------- lights & ground
scene.add(new THREE.HemisphereLight(0x8899bb, 0x0a0a0a, 0.55));
const key = new THREE.DirectionalLight(0xffffff, 1.15);
key.position.set(-60, 90, 60);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
const sc = key.shadow.camera;
sc.left = -110; sc.right = 110; sc.top = 110; sc.bottom = -110; sc.near = 1; sc.far = 300;
scene.add(key);
const fill = new THREE.DirectionalLight(0x4a6fa5, 0.4);
fill.position.set(70, 40, -60);
scene.add(fill);

const ground = new THREE.Mesh(
  new THREE.CircleGeometry(230, 96),
  new THREE.MeshStandardMaterial({ color: 0x111110, roughness: 0.95, metalness: 0.05 })
);
ground.rotation.x = -Math.PI / 2;
ground.position.y = -0.02;
ground.receiveShadow = true;
scene.add(ground);

const grid = new THREE.GridHelper(300, 75, 0x2c2c2a, 0x202020);
grid.material.transparent = true; grid.material.opacity = 0.5;
scene.add(grid);

// ---------------------------------------------------------------- label sprites
function labelSprite(text, { color = '#ffffff', size = 46, weight = 600, pad = 10, bg = null } = {}) {
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');
  const font = `${weight} ${size}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  ctx.font = font;
  const w = Math.ceil(ctx.measureText(text).width) + pad * 2;
  const h = size + pad * 2;
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  g.font = font; g.textBaseline = 'middle';
  if (bg) { g.fillStyle = bg; g.beginPath(); g.roundRect(0, 0, w, h, 12); g.fill(); }
  g.fillStyle = color; g.fillText(text, pad, h / 2 + 1);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  sp.scale.set(w / h, 1, 1);
  sp.userData.aspect = w / h;
  return sp;
}
function setSpriteText(sprite, text, opts) {
  if (sprite.userData.text === text) return;
  sprite.userData.text = text;
  const fresh = labelSprite(text, opts);
  sprite.material.map.dispose();
  sprite.material.map = fresh.material.map;
  sprite.material.needsUpdate = true;
  const s = sprite.userData.height || 1;
  sprite.scale.set(fresh.userData.aspect * s, s, 1);
  fresh.material.dispose();
}
function hexCss(n) { return '#' + n.toString(16).padStart(6, '0'); }
const trim = v => (Math.round(v * 10) / 10).toString();

// ---------------------------------------------------------------- campus
const towerGeo = new THREE.BoxGeometry(1, 1, 1);
towerGeo.translate(0, 0.5, 0);
const crownGeo = new THREE.BoxGeometry(1, 1, 1);
crownGeo.translate(0, 0.5, 0);

class Campus {
  constructor(site, slots) {
    this.site = site;
    this.color = SITE_COLOR[site];
    this.group = new THREE.Group();
    this.group.position.copy(SITE_POS[site]);
    scene.add(this.group);

    const pad = new THREE.Mesh(
      new THREE.CylinderGeometry(PAD_R, PAD_R + 0.7, 0.9, 64),
      new THREE.MeshStandardMaterial({ color: 0x1d1d1b, roughness: 0.75, metalness: 0.25 })
    );
    pad.position.y = 0.45; pad.receiveShadow = true;
    pad.userData.site = site;
    this.group.add(pad);
    this.pad = pad;

    const rim = new THREE.Mesh(
      new THREE.TorusGeometry(PAD_R + 0.2, 0.11, 8, 96),
      new THREE.MeshStandardMaterial({ color: this.color, emissive: this.color, emissiveIntensity: 1.4, roughness: 0.4 })
    );
    rim.rotation.x = Math.PI / 2; rim.position.y = 0.95;
    this.group.add(rim);

    // tower grid
    const n = Math.max(9, slots);
    const cols = Math.ceil(Math.sqrt(n));
    const span = (PAD_R * 1.42);
    const step = span / cols;
    this.step = step;
    this.towers = [];
    for (let i = 0; i < cols * cols; i++) {
      const cx = (i % cols - (cols - 1) / 2) * step;
      const cz = (Math.floor(i / cols) - (cols - 1) / 2) * step;
      const mat = new THREE.MeshStandardMaterial({ color: 0x2a2a28, emissive: 0x000000, roughness: 0.45, metalness: 0.35 });
      const m = new THREE.Mesh(towerGeo, mat);
      m.position.set(cx, 0.9, cz);
      m.scale.set(step * 0.52, 0.001, step * 0.52);
      m.castShadow = true; m.receiveShadow = true;
      m.visible = false;
      const crown = new THREE.Mesh(crownGeo, new THREE.MeshStandardMaterial({
        color: 0xe8e6df, emissive: 0xe8e6df, emissiveIntensity: 0.5, roughness: 0.4 }));
      crown.scale.set(1.12, 0.05, 1.12);
      crown.position.y = 1;        // sits on top in local (scaled) space
      crown.visible = false;
      m.add(crown);
      m.userData.crown = crown;
      this.group.add(m);
      this.towers.push(m);
    }

    // floating reserved slabs
    const slab = (color, y, op) => {
      const mm = new THREE.Mesh(
        new THREE.BoxGeometry(1, 0.55, 7),
        new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.5,
          transparent: true, opacity: op, roughness: 0.3 })
      );
      mm.position.set(0, y, 0); mm.visible = false;
      this.group.add(mm);
      return mm;
    };
    this.resSlab = slab(this.color, 15, 0.34);
    this.optSlab = slab(STATUS.warning, 18.5, 0.40);

    // spot pillars
    this.spots = [];
    for (let i = 0; i < 6; i++) {
      const p = new THREE.Mesh(
        new THREE.CylinderGeometry(0.16, 0.16, 9, 8, 1, true),
        new THREE.MeshStandardMaterial({ color: this.color, emissive: this.color, emissiveIntensity: 1.1,
          transparent: true, opacity: 0.5, side: THREE.DoubleSide })
      );
      const a = -0.95 + i * 0.38;
      p.position.set(Math.sin(a) * (PAD_R - 1.2), 5, Math.cos(a) * (PAD_R - 1.2));
      p.visible = false;
      this.group.add(p);
      this.spots.push(p);
    }

    // substation: height = energised MW, ghost box = contracted but not yet live
    const sub = new THREE.Mesh(towerGeo, new THREE.MeshStandardMaterial({
      color: 0x35352f, emissive: STATUS.warning, emissiveIntensity: 0.14, roughness: 0.6, metalness: 0.5 }));
    sub.position.set(0, 0.9, -(PAD_R + 4.2));
    sub.scale.set(2.8, 0.001, 2.8);
    sub.castShadow = true;
    this.group.add(sub);
    this.sub = sub;
    const ghost = new THREE.Mesh(towerGeo, new THREE.MeshBasicMaterial({
      color: STATUS.warning, wireframe: true, transparent: true, opacity: 0.35 }));
    ghost.position.copy(sub.position);
    ghost.scale.set(3.0, 0.001, 3.0);
    ghost.visible = false;
    this.group.add(ghost);
    this.ghost = ghost;

    // ground bar: served | training | unserved, with a demand tick
    this.bar = new THREE.Group();
    this.bar.position.set(0, 0.06, PAD_R + 2.6);
    this.group.add(this.bar);
    const seg = (color, op, emi) => {
      const g2 = new THREE.BoxGeometry(1, 0.4, 3.0);
      g2.translate(0.5, 0, 0);
      const mm = new THREE.Mesh(g2, new THREE.MeshStandardMaterial({
        color, emissive: color, emissiveIntensity: emi, transparent: op < 1, opacity: op, roughness: 0.5 }));
      mm.visible = false;
      this.bar.add(mm);
      return mm;
    };
    this.segServed = seg(this.color, 1, 0.75);
    this.segTrain = seg(this.color, 0.42, 0.3);
    this.segUnserved = seg(STATUS.critical, 1, 1.0);
    this.tick = new THREE.Mesh(
      new THREE.BoxGeometry(0.2, 1.1, 3.9),
      new THREE.MeshStandardMaterial({ color: INK, emissive: INK, emissiveIntensity: 0.9 })
    );
    this.bar.add(this.tick);

    // labels
    const name = labelSprite(SITE_NAME[site], { color: hexCss(this.color), size: 64, weight: 700 });
    name.userData.height = 2.6;
    name.scale.set(name.userData.aspect * 2.6, 2.6, 1);
    name.position.set(0, 23.5, 0);
    this.group.add(name);
    this.nameSprite = name;

    const stat = labelSprite('—', { color: '#c3c2b7', size: 40, weight: 500 });
    stat.userData.height = 1.35;
    stat.scale.set(stat.userData.aspect * 1.35, 1.35, 1);
    stat.position.set(0, 21.6, 0);
    this.group.add(stat);
    this.statSprite = stat;

    // event ring pool (broker delivered / cancelled)
    this.rings = [];
    for (let i = 0; i < 3; i++) {
      const r = new THREE.Mesh(
        new THREE.TorusGeometry(1, 0.22, 8, 64),
        new THREE.MeshBasicMaterial({ color: STATUS.good, transparent: true, opacity: 0 })
      );
      r.rotation.x = Math.PI / 2; r.position.y = 1.2; r.visible = false;
      this.group.add(r);
      this.rings.push(r);
    }
  }

  burst(color) {
    const r = this.rings.find(x => !x.visible) || this.rings[0];
    r.material.color.setHex(color);
    r.visible = true; r.userData.t = 0;
  }

  update(d, time) {
    const { ownedH, ownedN, poweredH, poweredN, reserved, option, spot, mw, mwPending,
            served, training, unserved, demand } = d;
    // towers: H first, then N
    const nH = Math.ceil(ownedH - 1e-6), nN = Math.ceil(ownedN - 1e-6);
    for (let i = 0; i < this.towers.length; i++) {
      const t = this.towers[i];
      let gen = null, frac = 0, lit = 0;
      if (i < nH) { gen = 'H'; frac = Math.min(1, ownedH - i); lit = Math.min(1, Math.max(0, poweredH - i)); }
      else if (i < nH + nN) { const j = i - nH; gen = 'N'; frac = Math.min(1, ownedN - j); lit = Math.min(1, Math.max(0, poweredN - j)); }
      if (!gen) { t.visible = false; continue; }
      t.visible = true;
      const compute = gen === 'N' ? 2 : 1;
      const target = Math.max(0.15, frac * compute * FLOOR_H);
      t.scale.y += (target - t.scale.y) * 0.16;
      const m = t.material;
      const want = lit > 0.5 ? this.color : 0x2a2a28;
      m.color.lerp(new THREE.Color(want), 0.12);
      m.emissive.lerp(new THREE.Color(lit > 0.5 ? this.color : 0x000000), 0.12);
      const pulse = 0.55 + 0.16 * Math.sin(time * 1.7 + i * 0.9);
      m.emissiveIntensity += ((lit > 0.5 ? pulse : 0) - m.emissiveIntensity) * 0.15;
      t.userData.crown.visible = gen === 'N';
    }
    // reserved / option slabs
    const slabW = (kh) => Math.max(0.001, kh * 1.5);
    this.resSlab.visible = reserved > 0.01;
    this.resSlab.scale.x += (slabW(reserved) - this.resSlab.scale.x) * 0.15;
    this.resSlab.position.y = 15 + Math.sin(time * 0.8) * 0.5;
    this.optSlab.visible = option > 0.01;
    this.optSlab.scale.x += (slabW(option) - this.optSlab.scale.x) * 0.15;
    this.optSlab.position.y = 18.5 + Math.sin(time * 0.8 + 1.2) * 0.5;
    // spot pillars
    for (let i = 0; i < this.spots.length; i++) {
      const on = spot > i * 0.9;
      this.spots[i].visible = on;
      if (on) this.spots[i].material.opacity = 0.28 + 0.3 * Math.abs(Math.sin(time * 3 + i));
    }
    // power
    const target = Math.max(0.001, mw * 0.22);
    this.sub.scale.y += (target - this.sub.scale.y) * 0.14;
    this.ghost.visible = mwPending > 0.01;
    if (this.ghost.visible) {
      const g = Math.max(0.001, (mw + mwPending) * 0.22);
      this.ghost.scale.y += (g - this.ghost.scale.y) * 0.14;
    }
    // ground bar
    const put = (mesh, x, w) => {
      mesh.visible = w > 0.02;
      mesh.position.x = x;
      mesh.scale.x += (Math.max(0.02, w) - mesh.scale.x) * 0.2;
    };
    this.bar.position.x = -(served + training + Math.max(0, unserved)) * KH / 2;
    put(this.segServed, 0, served * KH);
    put(this.segTrain, served * KH, training * KH);
    put(this.segUnserved, (served + training) * KH, unserved * KH);
    this.tick.position.x = demand * KH;
    this.tick.material.emissiveIntensity = unserved > 0.01 ? 1.6 : 0.8;
    // rings
    for (const r of this.rings) {
      if (!r.visible) continue;
      r.userData.t += 0.022;
      const t = r.userData.t;
      r.scale.setScalar(1 + t * 16);
      r.material.opacity = Math.max(0, 0.85 - t);
      if (t >= 0.85) { r.visible = false; r.material.opacity = 0; }
    }
  }
}

// ---------------------------------------------------------------- sources & routes
const sources = {};
function buildSources() {
  for (const k of Object.keys(SRC_POS)) {
    const g = new THREE.Group();
    g.position.copy(SRC_POS[k]);
    scene.add(g);
    const big = k === 'vendor';
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(big ? 26 : 14, big ? 7 : 5, big ? 11 : 8),
      new THREE.MeshStandardMaterial({ color: 0x232321, roughness: 0.65, metalness: 0.55 })
    );
    body.position.y = big ? 3.5 : 2.5;
    body.castShadow = true; body.receiveShadow = true;
    g.add(body);
    const strip = new THREE.Mesh(
      new THREE.BoxGeometry(big ? 26.4 : 14.2, 0.5, big ? 11.4 : 8.2),
      new THREE.MeshStandardMaterial({ color: STEEL, emissive: STEEL, emissiveIntensity: 0.8 })
    );
    strip.position.y = big ? 7.1 : 5.1;
    g.add(strip);
    const name = labelSprite(SRC_LABEL[k], { color: '#ffffff', size: 54, weight: 700 });
    name.userData.height = 2.4;
    name.scale.set(name.userData.aspect * 2.4, 2.4, 1);
    name.position.set(0, big ? 15 : 12, 0);
    g.add(name);
    const sub = labelSprite(SRC_SUB[k], { color: '#898781', size: 36, weight: 500 });
    sub.userData.height = 1.3;
    sub.scale.set(sub.userData.aspect * 1.3, 1.3, 1);
    sub.position.set(0, big ? 13.1 : 10.3, 0);
    g.add(sub);
    sources[k] = { group: g, strip, name, sub, body };
  }
}
buildSources();

const routes = {};   // routes[src][site] = {curve, tube}
function buildRoutes() {
  for (const s of Object.keys(SRC_POS)) {
    routes[s] = {};
    for (const site of Object.keys(SITE_POS)) {
      const a = SRC_POS[s].clone().setY(6);
      const b = SITE_POS[site].clone().setY(3);
      const mid = a.clone().add(b).multiplyScalar(0.5);
      mid.y = 30 + (s === 'vendor' ? 5 : 0);
      const curve = new THREE.QuadraticBezierCurve3(a, mid, b);
      const tube = new THREE.Mesh(
        new THREE.TubeGeometry(curve, 48, 0.09, 6, false),
        new THREE.MeshBasicMaterial({ color: SITE_COLOR[site], transparent: true, opacity: 0.1 })
      );
      scene.add(tube);
      routes[s][site] = { curve, tube };
    }
  }
}
buildRoutes();

// packet pool
const packetGeo = new THREE.OctahedronGeometry(1, 0);
const packets = [];
for (let i = 0; i < 28; i++) {
  const m = new THREE.Mesh(packetGeo, new THREE.MeshStandardMaterial({
    color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 1.6, roughness: 0.25 }));
  m.visible = false;
  m.castShadow = true;
  scene.add(m);
  packets.push(m);
}

// a ring at the vendor for the gen N launch
const launchRing = new THREE.Mesh(
  new THREE.TorusGeometry(1, 0.4, 10, 80),
  new THREE.MeshBasicMaterial({ color: 0x9085e9, transparent: true, opacity: 0 })
);
launchRing.rotation.x = Math.PI / 2;
launchRing.position.copy(SRC_POS.vendor).setY(2);
launchRing.visible = false;
scene.add(launchRing);

// ---------------------------------------------------------------- orbit controls
class Orbit {
  constructor(cam, dom, target) {
    this.cam = cam; this.dom = dom;
    this.target = target.clone();
    const off = cam.position.clone().sub(this.target);
    this.r = off.length();
    this.theta = Math.atan2(off.x, off.z);
    this.phi = Math.acos(THREE.MathUtils.clamp(off.y / this.r, -1, 1));
    this.vTheta = 0; this.vPhi = 0;
    this.autoRotate = true; this.autoSpeed = 0.035;
    this.dragging = 0;
    this.last = { x: 0, y: 0 };
    dom.addEventListener('pointerdown', e => {
      this.dragging = e.button === 2 || e.shiftKey ? 2 : 1;
      this.last = { x: e.clientX, y: e.clientY };
      dom.setPointerCapture(e.pointerId);
      this.userMoved = false;
    });
    dom.addEventListener('pointermove', e => {
      if (!this.dragging) return;
      const dx = e.clientX - this.last.x, dy = e.clientY - this.last.y;
      this.last = { x: e.clientX, y: e.clientY };
      if (Math.abs(dx) + Math.abs(dy) > 2) this.userMoved = true;
      if (this.dragging === 1) {
        this.vTheta -= dx * 0.0042;
        this.vPhi -= dy * 0.0036;
      } else {
        const panX = new THREE.Vector3().setFromMatrixColumn(cam.matrix, 0);
        const panZ = new THREE.Vector3().crossVectors(cam.up, panX);
        const k = this.r * 0.0014;
        this.target.addScaledVector(panX, -dx * k).addScaledVector(panZ, dy * k);
      }
    });
    const end = () => { this.dragging = 0; };
    dom.addEventListener('pointerup', end);
    dom.addEventListener('pointercancel', end);
    dom.addEventListener('contextmenu', e => e.preventDefault());
    dom.addEventListener('wheel', e => {
      e.preventDefault();
      this.r = THREE.MathUtils.clamp(this.r * (1 + Math.sign(e.deltaY) * 0.09), 34, 330);
    }, { passive: false });
  }
  update(dt) {
    if (this.autoRotate && !this.dragging) this.theta += this.autoSpeed * dt;
    this.theta += this.vTheta; this.phi += this.vPhi;
    this.vTheta *= 0.86; this.vPhi *= 0.86;
    this.phi = THREE.MathUtils.clamp(this.phi, 0.16, Math.PI / 2 - 0.30);
    const s = Math.sin(this.phi);
    this.cam.position.set(
      this.target.x + this.r * s * Math.sin(this.theta),
      this.target.y + this.r * Math.cos(this.phi),
      this.target.z + this.r * s * Math.cos(this.theta));
    this.cam.lookAt(this.target);
  }
}
const controls = new Orbit(camera, renderer.domElement, new THREE.Vector3(0, 5, -8));

// ---------------------------------------------------------------- data
const $ = id => document.getElementById(id);
let RUN = null, F = [], campuses = {}, orders = [], M = 24;
const state = { m: 0, playing: false, speed: 0.7, truth: false, lastMonth: -1 };

function buildOrderTable(frames) {
  const seen = new Map();
  frames.forEach(f => {
    f.queue.forEach(o => {
      if (!seen.has(o.id)) seen.set(o.id, { id: o.id, src: o.src, gen: o.gen, qty: o.qty, site: o.site,
                                            placed: o.placed, ready: o.ready, left: {}, first: f.month });
      const e = seen.get(o.id);
      e.left[f.month] = o.left;
      e.lastSeen = f.month;
    });
  });
  const brokerOutcome = new Map();
  frames.forEach(f => (f.broker || []).forEach(b => brokerOutcome.set(b.id, b.delivered)));
  const out = [];
  for (const e of seen.values()) {
    e.arrive = e.lastSeen + 1;                       // gone from the queue the month after it clears
    e.delivered = brokerOutcome.has(e.id) ? brokerOutcome.get(e.id) : true;
    e.start = Math.max(e.placed, frames[0].month - 1);
    out.push(e);
  }
  // moves between sites, parsed from the action log (the world does not record the origin)
  frames.forEach(f => (f.actions || []).forEach(a => {
    const p = a.trim().split(/\s+/);
    if (p[0] === 'move_gpus' && p.length >= 5) {
      out.push({ id: 'mv' + f.month + p[3] + p[4], src: p[3], gen: p[2].toUpperCase(), qty: +p[1],
                 site: p[4], placed: f.month, ready: f.month + 1, arrive: f.month + 1,
                 left: {}, move: true, delivered: true, start: f.month });
    }
  }));
  return out;
}

function leftAt(o, m) {
  const a = Math.floor(m), b = a + 1;
  const va = o.left[a] !== undefined ? o.left[a] : (o.left[b] !== undefined ? o.left[b] : o.qty);
  const vb = o.left[b] !== undefined ? o.left[b] : va;
  return va + (vb - va) * (m - a);
}

async function loadRun(key) {
  const doc = await (await fetch(`./data/${key}.json`)).json();
  RUN = doc; F = doc.frames; M = doc.frames.length;
  orders = buildOrderTable(F);
  // rebuild campuses sized to this run
  for (const c of Object.values(campuses)) scene.remove(c.group);
  campuses = {};
  for (const site of doc.sites) {
    let mx = 1;
    F.forEach(f => { mx = Math.max(mx, Math.ceil(f.owned[site].H) + Math.ceil(f.owned[site].N)); });
    campuses[site] = new Campus(site, mx);
  }
  $('sub').textContent = `${doc.title} — ${doc.subtitle}`;
  state.m = 0; state.lastMonth = -1;
  buildTimeline();
  renderTruth();
  syncHud(0);
}

// ---------------------------------------------------------------- per-frame scene update
const lerp = (a, b, u) => a + (b - a) * u;

function sceneUpdate(time) {
  const i0 = Math.min(M - 1, Math.floor(state.m));
  const i1 = Math.min(M - 1, i0 + 1);
  const u = THREE.MathUtils.clamp(state.m - i0, 0, 1);
  const A = F[i0], B = F[i1];

  for (const site of RUN.sites) {
    const a = A.sites[site], b = B.sites[site];
    const oa = A.owned[site], ob = B.owned[site];
    const contracts = (fr, opt) => fr.contracts
      .filter(c => !!c.option === opt && c.site === site && c.start <= fr.month && fr.month < c.end)
      .reduce((s, c) => s + c.qty, 0);
    const pendingMw = (fr) => fr.power
      .filter(p => p.site === site && p.start > fr.month)
      .reduce((s, p) => s + p.mw, 0);
    campuses[site].update({
      ownedH: lerp(oa.H, ob.H, u), ownedN: lerp(oa.N, ob.N, u),
      poweredH: lerp(a.powered.H, b.powered.H, u), poweredN: lerp(a.powered.N, b.powered.N, u),
      reserved: lerp(contracts(A, false), contracts(B, false), u),
      option: lerp(contracts(A, true), contracts(B, true), u),
      spot: lerp(a.spot_filled, b.spot_filled, u),
      mw: lerp(a.power_mw, b.power_mw, u),
      mwPending: lerp(pendingMw(A), pendingMw(B), u),
      served: lerp(a.served, b.served, u),
      training: lerp(a.training, b.training, u),
      unserved: lerp(Math.max(0, a.demand - a.served), Math.max(0, b.demand - b.served), u),
      demand: lerp(a.demand, b.demand, u),
    }, time);
  }

  // in-transit packets
  let p = 0;
  const touched = new Set();
  for (const o of orders) {
    if (p >= packets.length) break;
    if (state.m < o.placed || state.m >= o.arrive) continue;
    const span = Math.max(0.6, o.arrive - o.placed);
    const t = THREE.MathUtils.clamp((state.m - o.placed) / span, 0, 1);
    const route = routes[o.src] && routes[o.src][o.site];
    const curve = route ? route.curve
      : new THREE.QuadraticBezierCurve3(SITE_POS[o.src].clone().setY(4),
          SITE_POS[o.src].clone().add(SITE_POS[o.site]).multiplyScalar(0.5).setY(20),
          SITE_POS[o.site].clone().setY(3));
    const qty = o.move ? o.qty : Math.max(0.15, leftAt(o, state.m));
    const mesh = packets[p++];
    mesh.visible = true;
    curve.getPointAt(t, mesh.position);
    mesh.position.y += Math.sin(time * 2 + o.placed) * 0.5;
    const s = 0.75 + Math.cbrt(Math.max(0.2, qty)) * 0.85;
    mesh.scale.setScalar(s);
    mesh.rotation.y = time * 0.9 + o.placed;
    mesh.rotation.x = time * 0.5;
    const col = SITE_COLOR[o.site];
    mesh.material.color.setHex(col);
    mesh.material.emissive.setHex(o.delivered ? col : STATUS.critical);
    mesh.material.emissiveIntensity = 1.2 + 0.5 * Math.sin(time * 4 + o.placed);
    if (route) touched.add(o.src + '|' + o.site);
  }
  for (let i = p; i < packets.length; i++) packets[i].visible = false;
  for (const s of Object.keys(routes)) for (const site of Object.keys(routes[s])) {
    const t = routes[s][site].tube.material;
    const want = touched.has(s + '|' + site) ? 0.4 : 0.08;
    t.opacity += (want - t.opacity) * 0.08;
  }

  // vendor state: export controls choke it, gen N relabels it
  const vs = sources.vendor.strip.material;
  const choke = A.export_active;
  vs.color.lerp(new THREE.Color(choke ? STATUS.critical : STEEL), 0.08);
  vs.emissive.lerp(new THREE.Color(choke ? STATUS.critical : STEEL), 0.08);
  for (const b of ['A', 'B']) {
    const m = sources[b].strip.material;
    let c = STEEL;
    if (state.truth) c = RUN.truth.broker_reliable[b] && !(RUN.truth.broker_decay[b] !== null && A.month >= RUN.truth.broker_decay[b])
      ? STATUS.good : STATUS.critical;
    m.color.lerp(new THREE.Color(c), 0.1);
    m.emissive.lerp(new THREE.Color(c), 0.1);
  }
  if (launchRing.visible) {
    launchRing.userData.t += 0.02;
    launchRing.scale.setScalar(1 + launchRing.userData.t * 42);
    launchRing.material.opacity = Math.max(0, 0.7 - launchRing.userData.t);
    if (launchRing.userData.t > 0.75) launchRing.visible = false;
  }
}

// ---------------------------------------------------------------- HUD
const money = v => (v < 0 ? '−$' : '$') + Math.abs(v).toFixed(0) + 'M';
const COSTCATS = [
  ['capex', 'GPUs', '--s1'], ['contracts', 'reservations', '--s2'], ['power', 'power', '--s3'],
  ['interest', 'interest', '--s4'], ['spot', 'spot', '--s5'], ['options', 'options', '--s6'],
  ['other', 'unserved + moves', '--s7'],
];

function syncHud(i) {
  const f = F[i];
  $('mnum').textContent = f.month;

  // supply regime badge — hidden unless truth is on
  const rb = $('regime');
  const dot = rb.querySelector('.dot'), txt = rb.querySelector('span:last-child');
  if (state.truth) {
    dot.style.background = f.regime === 'tight' ? hexCss(STATUS.critical) : hexCss(STATUS.good);
    txt.textContent = `supply ${f.regime}` + (f.export_active ? ' · export controls' : '');
  } else {
    dot.style.background = 'var(--muted)';
    txt.textContent = 'supply unknown' + (f.export_active ? ' · export controls' : '');
  }

  const news = $('news');
  news.innerHTML = '';
  const items = f.news.length ? f.news : ['No headlines this month.'];
  items.forEach(t => {
    const li = document.createElement('li');
    li.textContent = t;
    if (/export|launch|aggressively/i.test(t)) li.className = 'hot';
    news.appendChild(li);
  });

  // tiles
  const spentTotal = Object.values(f.spent).reduce((a, b) => a + b, 0);
  $('cash').textContent = money(f.cash_end);
  $('cash').style.color = f.cash_end < 0 ? hexCss(STATUS.critical) : 'var(--ink)';
  $('cashsub').textContent = f.interest ? `interest ${money(f.interest)}` : 'no interest';
  $('spent').textContent = money(spentTotal);
  $('spentsub').textContent = f.spent.resale ? `resale credit ${money(f.spent.resale)}` : 'no resales yet';
  $('cap').textContent = f.capacity.toFixed(1) + ' kH';
  $('capsub').textContent = `${f.training.toFixed(1)} kH to training`;
  $('dem').textContent = f.demand.toFixed(1) + ' kH';
  const unser = Math.max(0, f.demand - f.served);
  $('dem').style.color = unser > 0.01 ? hexCss(STATUS.critical) : 'var(--ink)';
  $('demsub').textContent = unser > 0.01 ? `${unser.toFixed(2)} kH unserved` : 'fully served';

  // cash meter: −500 … +500
  const pct = v => THREE.MathUtils.clamp((v + 500) / 1000, 0, 1) * 100;
  const bar = $('cashbar');
  $('cashzero').style.left = '50%';
  if (f.cash_end >= 0) {
    bar.style.left = '50%'; bar.style.width = (pct(f.cash_end) - 50) + '%';
    bar.style.background = 'var(--s1)';
  } else {
    bar.style.left = pct(f.cash_end) + '%'; bar.style.width = (50 - pct(f.cash_end)) + '%';
    bar.style.background = hexCss(STATUS.critical);
  }

  // training windows
  const wins = $('wins');
  wins.innerHTML = '';
  RUN.milestones.forEach(([a, b, target], wi) => {
    const got = f.window_training[wi];
    const frac = Math.min(1, got / target);
    const over = f.month > b, inside = f.month >= a && f.month <= b;
    const done = frac >= 0.999;
    const el = document.createElement('div');
    el.className = 'win';
    el.innerHTML = `<div class="hdr"><span>run ${wi + 1} · months ${a}–${b}${inside ? ' · live' : ''}</span>
      <span><b>${got.toFixed(0)}</b> / ${target} kH-mo</span></div>
      <div class="wbar ${done ? 'done' : over ? 'late' : ''}"><i style="width:${(frac * 100).toFixed(1)}%"></i></div>`;
    wins.appendChild(el);
  });

  // cost stack
  const vals = {};
  COSTCATS.forEach(([k]) => { vals[k] = k === 'other' ? (f.spent.unserved + f.spent.moves) : f.spent[k]; });
  const tot = Object.values(vals).reduce((a, b) => a + b, 0) || 1;
  $('stack').innerHTML = COSTCATS.map(([k, , c]) =>
    vals[k] / tot > 0.004 ? `<i style="width:${(vals[k] / tot * 100).toFixed(2)}%;background:var(${c})"></i>` : ''
  ).join('');
  $('stacklegend').innerHTML = COSTCATS.map(([k, label, c]) =>
    `<span><b style="background:var(${c})"></b>${label}<u>${money(vals[k])}</u></span>`
  ).join('');

  // in transit
  const live = orders.filter(o => !o.move && o.placed <= f.month && f.month < o.arrive)
                     .sort((a, b) => a.arrive - b.arrive);
  $('shipcount').textContent = live.length ? `· ${live.length}` : '';
  $('ships').innerHTML = live.length ? live.map(o => {
    const left = o.left[f.month] !== undefined ? o.left[f.month] : o.qty;
    const eta = o.arrive - f.month;
    const waiting = o.src === 'vendor' && f.month >= o.ready;
    return `<tr>
      <td class="q">${left.toFixed(1)}k ${o.gen}</td>
      <td>${o.src === 'vendor' ? 'vendor' : 'broker ' + o.src}
        <span class="pill" style="background:${hexCss(SITE_COLOR[o.site])}">${SITE_NAME[o.site]}</span></td>
      <td class="e">${waiting ? 'awaiting allocation' : eta <= 1 ? 'next month' : 'in ' + eta + ' mo'}</td></tr>`;
  }).join('') : '<tr><td class="empty">nothing in transit</td></tr>';

  // actions + note
  const acts = f.actions || [];
  $('acts').innerHTML = acts.length
    ? acts.map(a => `<div class="${a.startsWith('#') ? 'bad' : ''}">${a.replace(/</g, '&lt;')}</div>`).join('')
    : '<div class="empty">no actions this month</div>';
  $('notepanel').hidden = !RUN.frames.some(x => x.note);
  $('note').textContent = f.note || '—';

  // timeline head
  $('tlhead').style.left = (f.month / (M - 1) * 100) + '%';
}

function renderTruth() {
  const t = RUN.truth, b = $('truthbody');
  const decay = k => t.broker_decay[k] !== null && t.broker_decay[k] !== undefined ? `, decays at m${t.broker_decay[k]}` : '';
  b.innerHTML = `
    <div><em>&#9679;</em>gen N launches month ${t.launch}</div>
    <div><em>&#9679;</em>${t.export === null ? 'no export controls' : `export controls at month ${t.export}`}</div>
    <div><em>&#9679;</em>${t.growth_switch === null ? 'inference growth never switches' : `growth switches at month ${t.growth_switch}`}</div>
    <div><em>&#9679;</em>broker A ${t.broker_reliable.A ? 'reliable' : 'unreliable'}${decay('A')}</div>
    <div><em>&#9679;</em>broker B ${t.broker_reliable.B ? 'reliable' : 'unreliable'}${decay('B')}</div>
    <div><em>&#9679;</em>net cost ${money(RUN.settlement.net_cost)} · ${RUN.settlement.milestones_met}/3 runs met</div>`;
}

function buildTimeline() {
  const tl = $('tl');
  tl.innerHTML = '<div class="track"></div>';
  const pos = m => (m / (M - 1)) * 100;
  RUN.milestones.forEach(([a, b], i) => {
    const seg = document.createElement('div');
    seg.className = 'wseg';
    seg.style.left = pos(a) + '%';
    seg.style.width = (pos(b) - pos(a)) + '%';
    tl.appendChild(seg);
    const lab = document.createElement('div');
    lab.className = 'wlab';
    lab.style.left = ((pos(a) + pos(b)) / 2) + '%';
    lab.textContent = `run ${i + 1}`;
    tl.appendChild(lab);
  });
  const play = document.createElement('div');
  play.className = 'play'; play.id = 'tlplay'; play.style.width = '0%';
  tl.appendChild(play);
  for (let m = 0; m < M; m++) {
    const t = document.createElement('div');
    t.className = 'tick'; t.style.left = pos(m) + '%';
    tl.appendChild(t);
    if (m % 4 === 0 || m === M - 1) {
      const l = document.createElement('div');
      l.className = 'mlab'; l.style.left = pos(m) + '%'; l.textContent = m;
      tl.appendChild(l);
    }
  }
  // event markers the player can see: broker outcomes
  F.forEach(f => (f.broker || []).forEach(b => {
    const mk = document.createElement('div');
    mk.className = 'mk';
    mk.style.left = pos(f.month) + '%';
    mk.style.background = b.delivered ? hexCss(STATUS.good) : hexCss(STATUS.critical);
    mk.title = `month ${f.month}: broker ${b.src} ${b.delivered ? 'delivered' : 'cancelled'} ${b.qty}k`;
    tl.appendChild(mk);
  }));
  const head = document.createElement('div');
  head.className = 'head'; head.id = 'tlhead';
  tl.appendChild(head);
}

// ---------------------------------------------------------------- events on month change
function onMonthEnter(i) {
  const f = F[i];
  (f.broker || []).forEach(b => campuses[b.site] &&
    campuses[b.site].burst(b.delivered ? STATUS.good : STATUS.critical));
  if (i > 0 && f.launched && !F[i - 1].launched) {
    launchRing.visible = true; launchRing.userData.t = 0;
    setSpriteText(sources.vendor.sub, 'gen N on sale · gen H discontinued', { color: '#9085e9', size: 36, weight: 600 });
  }
  if (i === 0) setSpriteText(sources.vendor.sub, SRC_SUB.vendor, { color: '#898781', size: 36, weight: 500 });
  for (const site of RUN.sites) {
    const s = f.sites[site];
    setSpriteText(campuses[site].statSprite,
      `${s.capacity.toFixed(1)} kH · ${trim(s.power_mw)} MW`,
      { color: '#c3c2b7', size: 40, weight: 500 });
  }
  syncHud(i);
}

// ---------------------------------------------------------------- tooltip
const tip = $('tip');
const ray = new THREE.Raycaster();
const ndc = new THREE.Vector2();
renderer.domElement.addEventListener('pointermove', e => {
  if (controls.dragging) { tip.style.opacity = 0; return; }
  ndc.x = (e.clientX / innerWidth) * 2 - 1;
  ndc.y = -(e.clientY / innerHeight) * 2 + 1;
  ray.setFromCamera(ndc, camera);
  const hit = ray.intersectObjects(Object.values(campuses).map(c => c.pad), false)[0];
  if (!hit) { tip.style.opacity = 0; return; }
  const site = hit.object.userData.site;
  const f = F[Math.min(M - 1, Math.floor(state.m))];
  const s = f.sites[site];
  const row = (k, v) => `<div class="r"><span>${k}</span><u>${v}</u></div>`;
  tip.innerHTML = `<b style="color:${hexCss(SITE_COLOR[site])}">${SITE_NAME[site]} — month ${f.month}</b>`
    + row('owned GPUs', `${f.owned[site].H.toFixed(1)}k H · ${f.owned[site].N.toFixed(1)}k N`)
    + row('powered', `${(s.powered.H + s.powered.N).toFixed(1)}k of ${(f.owned[site].H + f.owned[site].N).toFixed(1)}k`)
    + row('power', `${trim(s.power_mw)} MW`)
    + row('reserved', `${(+s.reserved).toFixed(1)} kH`)
    + row('spot', `${s.spot_filled.toFixed(1)} / ${(+s.spot_requested).toFixed(1)} kH`)
    + row('capacity', `${s.capacity.toFixed(1)} kH`)
    + row('inference', `${s.served.toFixed(2)} served of ${s.demand.toFixed(2)}`)
    + row('training', `${s.training.toFixed(1)} kH-months`);
  tip.style.opacity = 1;
  tip.style.left = Math.min(innerWidth - 260, e.clientX + 16) + 'px';
  tip.style.top = Math.min(innerHeight - 180, e.clientY + 14) + 'px';
});
renderer.domElement.addEventListener('pointerleave', () => { tip.style.opacity = 0; });

// ---------------------------------------------------------------- controls wiring
$('play').addEventListener('click', () => {
  state.playing = !state.playing;
  if (state.playing && state.m >= M - 1) state.m = 0;
  $('play').innerHTML = state.playing ? '⏸ pause' : '▶ play';
});
$('step').addEventListener('click', () => {
  state.playing = false;
  $('play').innerHTML = '▶ play';
  state.m = Math.min(M - 1, Math.floor(state.m) + 1);
});
$('speed').addEventListener('change', e => { state.speed = +e.target.value; });
$('spin').addEventListener('click', e => {
  controls.autoRotate = !controls.autoRotate;
  e.currentTarget.setAttribute('aria-pressed', String(controls.autoRotate));
});
$('truth').addEventListener('click', e => {
  state.truth = !state.truth;
  e.currentTarget.setAttribute('aria-pressed', String(state.truth));
  $('truthpanel').hidden = !state.truth;
  syncHud(Math.min(M - 1, Math.floor(state.m)));
});
const tlEl = $('tl');
const scrub = e => {
  const r = tlEl.getBoundingClientRect();
  state.m = THREE.MathUtils.clamp((e.clientX - r.left) / r.width, 0, 1) * (M - 1);
};
tlEl.addEventListener('pointerdown', e => { state.playing = false; $('play').innerHTML = '▶ play'; tlEl.setPointerCapture(e.pointerId); tlEl.dataset.down = '1'; scrub(e); });
tlEl.addEventListener('pointermove', e => { if (tlEl.dataset.down) scrub(e); });
tlEl.addEventListener('pointerup', e => { delete tlEl.dataset.down; tlEl.releasePointerCapture(e.pointerId); });
addEventListener('keydown', e => {
  if (e.key === ' ') { e.preventDefault(); $('play').click(); }
  if (e.key === 'ArrowRight') state.m = Math.min(M - 1, Math.floor(state.m) + 1);
  if (e.key === 'ArrowLeft') state.m = Math.max(0, Math.ceil(state.m) - 1);
});
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  if (composer) composer.setSize(innerWidth, innerHeight);
});

// ---------------------------------------------------------------- boot
const clock = new THREE.Clock();
function tick() {
  requestAnimationFrame(tick);
  const dt = Math.min(0.05, clock.getDelta());
  const time = clock.elapsedTime;
  if (state.playing) {
    state.m += dt * state.speed;
    if (state.m >= M - 1) { state.m = M - 1; state.playing = false; $('play').innerHTML = '▶ play'; }
  }
  if (RUN) {
    const i = Math.min(M - 1, Math.floor(state.m));
    if (i !== state.lastMonth) { state.lastMonth = i; onMonthEnter(i); }
    const tp = document.getElementById('tlplay');
    if (tp) tp.style.width = (state.m / (M - 1) * 100) + '%';
    sceneUpdate(time);
  }
  controls.update(dt);
  if (composer) composer.render(); else renderer.render(scene, camera);
}

(async function boot() {
  const runs = await (await fetch('./data/index.json')).json();
  const sel = $('run');
  runs.forEach(r => {
    const o = document.createElement('option');
    o.value = r.key;
    o.textContent = `${r.title} — ${money(r.net_cost)}` + (r.reward ? ` (reward ${r.reward})` : '');
    sel.appendChild(o);
  });
  sel.addEventListener('change', () => loadRun(sel.value));
  const qs = new URLSearchParams(location.search);
  const want = qs.get('run') && runs.some(r => r.key === qs.get('run')) ? qs.get('run') : runs[0].key;
  sel.value = want;
  await loadRun(want);
  if (qs.has('m')) state.m = THREE.MathUtils.clamp(+qs.get('m'), 0, M - 1);
  if (qs.get('spin') === '0') { controls.autoRotate = false; $('spin').setAttribute('aria-pressed', 'false'); }
  if (qs.get('truth') === '1') $('truth').click();
  tick();
  const l = $('loading');
  l.style.opacity = 0;
  setTimeout(() => l.remove(), 520);
})().catch(err => {
  console.error(err);
  $('loading').textContent = 'failed to load: ' + err.message + ' — serve this folder over http (see viz/README.md)';
});
