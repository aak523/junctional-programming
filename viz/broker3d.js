/* A broker, as an object.

   A shop. It is the one place in the game you simply walk into and buy: no allocation, no
   queue, no waiting your turn — just a counter, a price, and a month's wait to find out
   whether the goods turn up at all. So it is a shopfront — a lit window, a door, a money
   sign over it — and the sign is the price: `$` for broker A at 1.10x list, `$$` for
   broker B at 1.25x. An order stands on the counter for its one month and is then either
   carried out the front (delivered in full) or voided on the spot (80% of what you paid
   comes back, and you keep the 20% loss).

   Everything the shop holds stands in front of it as blocks, one block to the thousand:
   what you have just bought, what is resolving tonight, and what the stamp has just sent
   out or voided. Nothing here is a length or a level — you count it.

   Built here, on its own, so it can be worked on alone (viz/broker.html) and dropped onto
   the sphere by the caller (viz/world3d.js), which positions it and owns its labels.

   Read it as a gauge:
     sign        = the markup, $ or $$        · counter = the order resolving this month
     forecourt   = what has just been bought, waiting its month
     green block = delivered in full          · red = voided, 80% back                   */
import * as THREE from 'three';
import { STATUS } from './campus3d.js';

// --- the real constants, from world.py --------------------------------------------------
export const Q_HI = 0.9;            // fill probability while the broker is reliable
export const Q_LO = 0.35;           // once unreliable, or once it has decayed
export const REFUND = 0.8;          // of what you paid, on a cancellation
export const CAP = 4.0;             // thousands per broker per month

// --- dimensions -------------------------------------------------------------------------
export const DECK = 0.5;            // apron thickness, as the campus
export const SHOP_W = 11.0;
export const SHOP_D = 7.0;
export const SHOP_H = 5.0;
export const COUNTER_Z = 1.0;       // how far the counter stands off the shopfront
export const BLOCK = 0.9;           // one thousand GPUs, as a block
export const PITCH = 1.05;          // and the step between blocks
export const ROW = 6;               // blocks to a row before it wraps back
export const PAD_R = 10.0;          // footprint a caller should leave

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// --- geometry built once and shared ------------------------------------------------------
const padGeo = new THREE.BoxGeometry(1, DECK, 1);
padGeo.translate(0, DECK / 2, 0);
const shopGeo = new THREE.BoxGeometry(SHOP_W, SHOP_H, SHOP_D);
shopGeo.translate(0, SHOP_H / 2, 0);
const parapetGeo = new THREE.BoxGeometry(SHOP_W + 0.6, 0.7, SHOP_D + 0.6);
const winGeo = new THREE.BoxGeometry(SHOP_W - 4.0, 2.4, 0.25);
const doorGeo = new THREE.BoxGeometry(1.7, 2.6, 0.2);
doorGeo.translate(0, 1.3, 0);
const counterGeo = new THREE.BoxGeometry(SHOP_W - 1.6, 0.8, 1.9);
counterGeo.translate(0, 0.4, 0);
const boardGeo = new THREE.BoxGeometry(4.2, 1.5, 0.18);
const signGeo = new THREE.PlaneGeometry(3.8, 1.3);
const blockGeo = new THREE.BoxGeometry(BLOCK, BLOCK, BLOCK);
blockGeo.translate(0, BLOCK / 2, 0);

/* The money sign, painted. It is a shop sign — the one piece of lettering in the system,
   and it is lettering because that is what a shop puts over its door. */
function signTexture(glyphs, css) {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 192;
  const g = c.getContext('2d');
  g.fillStyle = css;
  g.font = 'bold 150px ui-monospace, "SF Mono", Menlo, monospace';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(glyphs, 256, 104);
  const t = new THREE.CanvasTexture(c);
  t.anisotropy = 4;
  return t;
}

export class Broker {
  /* theme · metal: v => v so a paper key flattens metalness · markup: 1.10 or 1.25,
     which is what the sign says */
  constructor({ theme, metal = v => v, markup = 1.10 }) {
    const T = this.theme = theme;
    this.markup = markup;
    this.first = true;
    this.group = new THREE.Group();
    const add = (m, p = this.group) => { p.add(m); return m; };
    const std = (color, o = {}) => new THREE.MeshStandardMaterial({
      color, roughness: o.rough ?? 0.7, metalness: metal(o.metal ?? 0.2),
      emissive: o.emissive ?? 0x000000, emissiveIntensity: (o.emi ?? 0) * T.emissive });

    this.pad = add(new THREE.Mesh(padGeo, std(T.pad, { rough: 0.92, metal: 0.1 })));
    this.pad.scale.set(PAD_R * 2, 1, 16);
    this.pad.position.z = 1.5;
    this.pad.receiveShadow = true;
    this.padEdge = add(new THREE.LineSegments(new THREE.EdgesGeometry(padGeo),
      new THREE.LineBasicMaterial({ color: T.trim, transparent: true, opacity: 0.3 })));
    this.padEdge.scale.copy(this.pad.scale);
    this.padEdge.position.z = this.pad.position.z;

    // --- the shop
    const z0 = -(SHOP_D / 2 + 2.0);
    const shop = add(new THREE.Mesh(shopGeo, std(T.shed, { rough: 0.78, metal: 0.15 })));
    shop.position.set(0, DECK, z0);
    shop.castShadow = shop.receiveShadow = true;
    const parapet = add(new THREE.Mesh(parapetGeo, std(T.roof, { rough: 0.6, metal: 0.3 })));
    parapet.position.set(0, DECK + SHOP_H + 0.35, z0);

    const face = z0 + SHOP_D / 2;                 // the shopfront plane
    this.win = add(new THREE.Mesh(winGeo, std(T.hub, {
      rough: 0.25, metal: 0.5, emissive: T.tick, emi: 0.45 })));
    this.win.position.set(-1.6, DECK + 1.9, face + 0.08);
    const door = add(new THREE.Mesh(doorGeo, std(T.roof, {
      rough: 0.5, metal: 0.3, emissive: T.tick, emi: 0.12 })));
    door.position.set(SHOP_W / 2 - 2.0, DECK, face + 0.05);

    this.counter = add(new THREE.Mesh(counterGeo, std(T.roof, { rough: 0.6, metal: 0.25 })));
    this.counter.position.set(0, DECK, face + COUNTER_Z);

    // the money sign over the door: one $ at 1.10x, two at 1.25x
    const board = add(new THREE.Mesh(boardGeo, std(T.hub, { rough: 0.55, metal: 0.35 })));
    board.position.set(0, DECK + 4.1, face + 0.12);
    const sign = add(new THREE.Mesh(signGeo, new THREE.MeshBasicMaterial({
      map: signTexture(markup >= 1.2 ? '$$' : '$', T.ink), transparent: true })));
    sign.position.set(0, DECK + 4.1, face + 0.23);

    // --- the stock, as blocks: one to the thousand, standing in front of the shop
    this.blocks = [];
    for (let i = 0; i < 60; i++) {
      const m = add(new THREE.Mesh(blockGeo, std(T.trim, { rough: 0.6 })));
      m.castShadow = true;
      m.visible = false;
      this.blocks.push(m);
    }
  }

  /* d: hold:     [{ qty, site }]            the order resolving at the end of this month
        intake:   [{ qty, site }]            bought this month, waiting its month
        resolved: [{ qty, site, delivered }] stamped this month                          */
  update(d, time) {
    const T = this.theme;
    const hold = d.hold || [], intake = d.intake || [], resolved = d.resolved || [];
    const pulse = 0.5 + 0.3 * Math.sin(time * 1.9);

    // the stock, counted out in blocks: on the counter (resolving tonight), on the
    // forecourt (just bought), and out front once stamped — green standing, red tipped
    let bi = 0;
    const face = -(SHOP_D / 2 + 2.0) + SHOP_D / 2;
    const put = (list, z0, mode) => {
      if (!list.length) return;
      const widths = list.map(o => Math.min(Math.max(1, Math.ceil(o.qty - 1e-6)), ROW));
      const span = widths.reduce((a, w) => a + (w + 0.8) * PITCH, 0) - 0.8 * PITCH;
      let x0 = -span / 2;
      for (const o of list) {
        const n = Math.max(1, Math.ceil(o.qty - 1e-6));
        for (let i = 0; i < n && bi < this.blocks.length; i++) {
          const m = this.blocks[bi++];
          m.visible = true;
          const c = mode === 'done'
            ? (o.delivered ? STATUS.good : STATUS.critical)
            : (T.site[o.site] ?? T.trim);
          m.material.color.set(c);
          m.material.emissive.set(mode === 'done' ? c : 0x000000);
          m.material.emissiveIntensity = (mode === 'done' ? 0.75 * pulse : 0) * T.emissive;
          const col = i % ROW, row = Math.floor(i / ROW);
          m.position.set(x0 + col * PITCH, mode === 'hold' ? DECK + 0.8 : DECK,
                         z0 + row * PITCH);
          m.rotation.z = (mode === 'done' && !o.delivered) ? 0.42 : 0;   // voided, tipped over
        }
        x0 += (Math.min(n, ROW) + 0.8) * PITCH;      // the next order starts clear of this one
      }
    };
    put(hold, face + COUNTER_Z - 0.4, 'hold');
    put(intake, face + 2.9, 'in');
    put(resolved, face + 5.0, 'done');
    for (let i = bi; i < this.blocks.length; i++) this.blocks[i].visible = false;

    this.first = false;
  }
}
