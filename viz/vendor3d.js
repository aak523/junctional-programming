/* The vendor: the fab and its two allocated queues, as an object.

   A factory — a long hall under a sawtooth roof with three smoking chimneys — and the
   order book standing in front of it as two lines of freight, one per generation. Each
   order holds its place in the line in the order it was placed, head of the line at the
   factory door: strictly first in, first out, whatever site it is going to. The month's
   allocation is a pour that starts at the door and reaches as far as the budget goes,
   so a 30k order at the head is a long crate the pour barely crosses, and everything
   behind it stands in the dark.

   Built here, on its own, so it can be worked on alone (viz/vendor.html) and dropped onto
   the sphere by the caller (viz/world3d.js), which positions it and owns its labels.

   Read it as a gauge:
     block       = one thousand GPUs still undelivered, in its destination's colour
     a run        = one order; the gap behind it is what has already shipped
     lit blocks  = eligible (placed + MIN_LEAD - 1 months ago); matte = still waiting
     green reach = how far this month's allocation got before it ran out
     red smoke   = export controls, on the gen H side only
     door shutter down = that generation is not on sale (N before the launch, H after)   */
import * as THREE from 'three';
import { STATUS } from './campus3d.js';

// --- the real constants, from world.py --------------------------------------------------
export const MIN_LEAD = 3;          // an order placed in p first receives at the end of p+2
export const ALLOC = { H: { loose: 6.0, tight: 2.0 }, N: { loose: 4.0, tight: 1.5 } };  // k/month
export const EXPORT_ALLOC = 0.4;    // export controls multiply the H budget by this

// --- dimensions -------------------------------------------------------------------------
export const COLS = 3;              // blocks across a line
export const PITCH = 0.78;          // between block centres, both ways
export const K = PITCH / COLS;      // world units per thousand GPUs, along a line
export const DECK = 0.5;            // apron thickness, as the campus
export const PLANT_W = 24.0;        // the hall, across
export const PLANT_D = 10.0;        // the hall, deep
export const PLANT_H = 6.0;         // to the eaves
export const TEETH = 5;             // sawtooth bays across the depth
export const STACKS = 3;            // chimneys
export const STACK_H = 5.0;
export const LANE_SEP = 11.0;       // between the two line centres
export const LANE_MIN = 10.0;       // an empty line is still a length of apron
export const BLOCK = 0.62;          // one thousand GPUs, as a block
export const BLOCK_H = 0.62;
export const SLOTS = 12;            // orders drawn per line, head of the line first
export const BLOCKS = 90;           // blocks drawn per line before the tail is left out
export const PAD_R = 32.0;          // footprint a caller should leave for the fab

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// --- geometry built once and shared ------------------------------------------------------
const padGeo = new THREE.BoxGeometry(1, DECK, 1);
padGeo.translate(0, DECK / 2, 0);

const hallGeo = new THREE.BoxGeometry(PLANT_W, PLANT_H, PLANT_D);
hallGeo.translate(0, PLANT_H / 2, 0);

// the sawtooth: one tooth is a vertical face and a long slope, repeated across the depth
const roofGeo = (() => {
  const t = PLANT_D / TEETH, rise = 1.7;
  const s = new THREE.Shape();
  s.moveTo(-PLANT_D / 2, 0);
  for (let i = 0; i < TEETH; i++) {
    const x0 = -PLANT_D / 2 + i * t;
    s.lineTo(x0, rise);                 // the glazed vertical face
    s.lineTo(x0 + t, 0);                // and the slope back down
  }
  s.lineTo(PLANT_D / 2, 0);
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: PLANT_W, bevelEnabled: false, curveSegments: 1 });
  g.translate(0, 0, -PLANT_W / 2);
  g.rotateY(Math.PI / 2);               // teeth run across the depth, the hall along x
  return g;
})();

const stackGeo = new THREE.CylinderGeometry(0.62, 0.92, STACK_H, 14, 1);
stackGeo.translate(0, STACK_H / 2, 0);
const bandGeo = new THREE.CylinderGeometry(0.70, 0.70, 0.5, 14, 1);
const puffGeo = new THREE.SphereGeometry(1, 10, 8);
const doorGeo = new THREE.BoxGeometry(3.6 + 1.2, 3.4, 0.4);
doorGeo.translate(0, 1.7, 0);
const shutGeo = new THREE.BoxGeometry(3.6 + 1.0, 1, 0.5);
shutGeo.translate(0, -0.5, 0);          // drops from the lintel
const blockGeo = new THREE.BoxGeometry(BLOCK, BLOCK_H, BLOCK);
blockGeo.translate(0, BLOCK_H / 2, 0);
// the pour rides over the top of the line, where no block can hide it
const reachGeo = new THREE.BoxGeometry(1, 0.22, COLS * PITCH + 0.2);
reachGeo.translate(0.5, 0, 0);

export class Vendor {
  /* theme: the key's colours · metal: v => v, so a paper key flattens every metalness */
  constructor({ theme, metal = v => v }) {
    const T = this.theme = theme;
    this.group = new THREE.Group();
    this.siteColor = T.site;
    const add = (m, p = this.group) => { p.add(m); return m; };
    const std = (color, o = {}) => new THREE.MeshStandardMaterial({
      color, roughness: o.rough ?? 0.72, metalness: metal(o.metal ?? 0.2),
      emissive: o.emissive ?? 0x000000, emissiveIntensity: (o.emi ?? 0) * T.emissive });

    this.pad = add(new THREE.Mesh(padGeo, std(T.pad, { rough: 0.92, metal: 0.1 })));
    this.pad.receiveShadow = true;
    this.padEdge = add(new THREE.LineSegments(new THREE.EdgesGeometry(padGeo),
      new THREE.LineBasicMaterial({ color: T.trim, transparent: true, opacity: 0.35 })));

    // --- the factory
    const hall = add(new THREE.Mesh(hallGeo, std(T.shed, { rough: 0.8, metal: 0.15 })));
    hall.position.set(0, DECK, -(PLANT_D / 2 + 1.5));
    hall.castShadow = hall.receiveShadow = true;
    const roof = add(new THREE.Mesh(roofGeo, std(T.roof, { rough: 0.6, metal: 0.3 })));
    roof.position.set(0, DECK + PLANT_H, -(PLANT_D / 2 + 1.5));
    roof.castShadow = true;

    this.stacks = [];
    for (let i = 0; i < STACKS; i++) {
      const x = (i - (STACKS - 1) / 2) * (PLANT_W / (STACKS + 0.6));
      const s = add(new THREE.Mesh(stackGeo, std(T.steel, { rough: 0.65, metal: 0.4 })));
      s.position.set(x, DECK + PLANT_H + 1.2, -(PLANT_D / 2 + 1.5));
      s.castShadow = true;
      const band = add(new THREE.Mesh(bandGeo, std(T.trim, { rough: 0.5, metal: 0.4 })));
      band.position.set(x, DECK + PLANT_H + 1.2 + STACK_H - 0.9, -(PLANT_D / 2 + 1.5));
      // a short plume, so a chimney reads as a chimney
      const puffs = [];
      for (let j = 0; j < 3; j++) {
        const p = add(new THREE.Mesh(puffGeo, new THREE.MeshStandardMaterial({
          color: T.trim, transparent: true, opacity: 0, roughness: 1 })));
        p.position.set(x, 0, -(PLANT_D / 2 + 1.5));
        puffs.push(p);
      }
      this.stacks.push({ stack: s, band, puffs, x });
    }

    // --- the two lines, one per generation. Each lane is a group standing at the factory
    // door and turned so its local +x runs out in front of the hall; everything inside it
    // is laid out along that one axis, head of the line at zero.
    this.lanes = {};
    for (const gen of ['H', 'N']) {
      const L = { len: LANE_MIN, reach: 0.001, surge: 0 };
      const g = add(new THREE.Group());
      g.position.set((gen === 'H' ? -1 : 1) * LANE_SEP / 2, 0, -1.5);
      g.rotation.y = -Math.PI / 2;
      L.group = g;

      L.door = add(new THREE.Mesh(doorGeo, std(T.roof, { rough: 0.5, metal: 0.35 })), g);
      L.door.position.set(0, DECK, 0);
      L.door.rotation.y = Math.PI / 2;
      L.shutter = add(new THREE.Mesh(shutGeo, std(T.towerOff, { rough: 0.6, metal: 0.3 })), g);
      L.shutter.position.set(0, DECK + 3.4, 0);
      L.shutter.rotation.y = Math.PI / 2;
      L.shutter.scale.y = 0.001;

      // the pour: a band from the door to wherever the month's allocation ran out
      L.reachBar = add(new THREE.Mesh(reachGeo, new THREE.MeshStandardMaterial({
        color: STATUS.good, emissive: STATUS.good, emissiveIntensity: 0.9 * T.emissive,
        transparent: true, opacity: 0.8, roughness: 0.35 })), g);
      L.reachBar.position.set(0, DECK + BLOCK_H + 0.3, 0);

      // the order book, counted out one block to the thousand
      L.blocks = [];
      for (let i = 0; i < BLOCKS; i++) {
        const b = add(new THREE.Mesh(blockGeo, std(T.trim, { rough: 0.6 })), g);
        b.position.set(0, DECK, 0);
        b.castShadow = true;
        b.visible = false;
        L.blocks.push(b);
      }
      this.lanes[gen] = L;
    }
  }

  pour(gen) { if (this.lanes[gen]) this.lanes[gen].surge = 1; }

  /* d: month (int), launched (bool), exportActive (bool)
        budget: { H, N }  thousands this month — ALLOC[gen][regime] x noise x export
        queue: [{ gen, site, qty, left, placed }] the vendor orders, in insertion order   */
  update(d, time) {
    const T = this.theme;
    const { month = 0, launched = false, exportActive = false } = d;
    const budget = d.budget || { H: 0, N: 0 };
    const queue = d.queue || [];
    let outer = LANE_MIN;

    for (const gen of ['H', 'N']) {
      const L = this.lanes[gen];
      const orders = queue.filter(o => o.gen === gen && o.left > 1e-6).slice(0, SLOTS);

      // eligibility, exactly as world.py: k >= placed + MIN_LEAD - 1, and monotone in
      // insertion order, so the eligible orders are a run at the head of the line
      let content = 0, live = true;
      const bays = orders.map(o => {
        const start = content;
        content += o.qty * K;
        const elig = live && month >= o.placed + MIN_LEAD - 1;
        if (!elig) live = false;
        return { o, start, elig };
      });

      // pour the budget over the eligible orders in insertion order; where it runs out is
      // where the line goes dark
      let b = (budget[gen] || 0) * K, front = 0;
      for (const bay of bays) {
        if (!bay.elig) break;
        const solid = bay.o.left * K;
        if (b >= solid) { b -= solid; front = bay.start + bay.o.qty * K; }
        else { front = bay.start + b; b = 0; break; }
      }

      L.len += (Math.max(LANE_MIN, content + 3.0) - L.len) * 0.12;
      outer = Math.max(outer, L.len);

      // on sale: N only from the launch, H only until it. The shutter comes down on the
      // door; the line behind it still drains.
      const onSale = gen === 'H' ? !launched : launched;
      L.shutter.scale.y += ((onSale ? 0.001 : 3.3) - L.shutter.scale.y) * 0.1;

      L.surge *= 0.972;
      L.reach += (Math.max(0.001, front) - L.reach) * 0.14;
      L.reachBar.visible = L.reach > 0.08 && (budget[gen] || 0) > 0.01;
      L.reachBar.scale.x = L.reach;
      L.reachBar.material.opacity = 0.72 + 0.2 * L.surge + 0.05 * Math.sin(time * 2.2);

      // one block per thousand still undelivered, three to a row, standing in its order's
      // own span — so the gap at the back of a span is what that order has already shipped
      let bi = 0;
      for (const { o, start, elig } of bays) {
        const n = Math.max(1, Math.ceil(o.left - 1e-6));
        const c = this.siteColor[o.site] ?? T.site.us;
        for (let i = 0; i < n && bi < L.blocks.length; i++) {
          const b = L.blocks[bi++];
          b.visible = true;
          const row = Math.floor(i / COLS), col = i % COLS;
          b.position.set(start + (row + 0.5) * PITCH, DECK, (col - (COLS - 1) / 2) * PITCH);
          b.material.color.set(c);
          b.material.emissive.set(c);
          b.material.emissiveIntensity = (elig ? 0.45 : 0) * T.emissive;
        }
      }
      for (let i = bi; i < L.blocks.length; i++) L.blocks[i].visible = false;
    }

    // export controls choke gen H: the chimneys say so, since the factory is what is choked
    const choked = exportActive;
    const smoke = choked ? STATUS.critical : T.trim;
    for (const st of this.stacks) {
      st.band.material.color.lerp(new THREE.Color(choked ? STATUS.critical : T.trim), 0.1);
      st.band.material.emissive.lerp(new THREE.Color(choked ? STATUS.critical : 0x000000), 0.1);
      st.band.material.emissiveIntensity = (choked ? 1.2 + 0.4 * Math.sin(time * 4.5) : 0) * T.emissive;
      for (let j = 0; j < st.puffs.length; j++) {
        const p = st.puffs[j];
        const u = ((time * 0.26 + j / st.puffs.length) % 1);          // rise and fade
        p.position.y = DECK + PLANT_H + 1.2 + STACK_H + u * 3.4;
        p.scale.setScalar(0.6 + u * 1.1);
        p.material.opacity = 0.3 * (1 - u) * (choked ? 1.2 : 1);
        p.material.color.lerp(new THREE.Color(smoke), 0.08);
      }
    }

    const back = -(PLANT_D + 4), fwd = outer + 3;
    this.pad.scale.set(PLANT_W + 6, 1, fwd - back);
    this.pad.position.z = (fwd + back) / 2;
    this.padEdge.scale.copy(this.pad.scale);
    this.padEdge.position.z = this.pad.position.z;
  }
}
