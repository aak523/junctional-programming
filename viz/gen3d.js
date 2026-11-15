/* A GPU generation, as an object.

   A block — the unit you actually buy. One block is one kH of compute, so gen H is a
   single block and gen N is two: a thousand units of N carry twice what a thousand of H
   carry, and that is the whole difference between them, made countable.

   The block is lit while the generation is on sale and goes matte the month it is
   discontinued; a generation that has not launched yet is only an outline. In front of it
   stands what one unit is worth, in small blocks of $5M each — a row that drops by two
   fifths in a single month when gen N launches and gen H is marked down, and rots 2% a
   month besides, to the near-write-off at month 24.

   Built here, on its own, so it can be worked on alone (viz/gen.html) and dropped into a
   page by the caller, which positions it and owns its labels.

   Read it as a gauge:
     block count     = compute per unit — one for gen H, two for gen N
     lit             = on sale · matte = discontinued · outline = not launched yet
     blocks in front = market value, $5M each; you only ever get RESALE (75%) of it      */
import * as THREE from 'three';
import { STATUS } from './campus3d.js';

// --- the real constants, from world.py --------------------------------------------------
export const GPU_PRICE = { H: 25.0, N: 40.0 };   // $M per thousand GPUs
export const COMPUTE = { H: 1.0, N: 2.0 };       // kH per thousand GPUs
export const POWER_MW = { H: 1.4, N: 1.6 };      // MW per thousand GPUs
export const RESALE = 0.75;                      // resale and settlement mark = 75% of market value
export const DECAY = 0.98;                       // market value, per month
export const LAUNCH_MV = 0.6;                    // gen H's haircut from the launch month on

// --- dimensions -------------------------------------------------------------------------
export const DECK = 0.5;              // deck thickness, as the campus apron
export const DECK_W = 9.0;
export const DECK_D = 8.0;
export const PAD_R = DECK_W / 2;      // the footprint one generation needs, for callers
export const UNIT = 2.4;              // one kH of compute, as a block
export const UNIT_GAP = 0.35;
export const PER_BLOCK = 5.0;         // $M of market value to a small block
export const VAL = 0.52;
export const VAL_PITCH = 0.64;

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/* world.py's market_value, in $M per thousand: gen H decays from its list price and takes
   a 40% haircut the month gen N exists; gen N does not exist at all until then. */
export function marketValue(gen, month, launch) {
  const launched = launch !== null && month >= launch;
  if (gen === 'H') return GPU_PRICE.H * DECAY ** month * (launched ? LAUNCH_MV : 1);
  return launched ? GPU_PRICE.N * DECAY ** (month - launch) : 0;
}

// --- geometry built once and shared ------------------------------------------------------
const deckGeo = new THREE.BoxGeometry(DECK_W, DECK, DECK_D);
deckGeo.translate(0, DECK / 2, 0);
const unitGeo = new THREE.BoxGeometry(UNIT, UNIT, UNIT);
unitGeo.translate(0, UNIT / 2, 0);
const unitEdges = new THREE.EdgesGeometry(unitGeo);
const bandGeo = new THREE.BoxGeometry(UNIT * 1.02, 0.16, UNIT * 1.02);   // a face, so it is not a bare cube
const valGeo = new THREE.BoxGeometry(VAL, VAL, VAL);
valGeo.translate(0, VAL / 2, 0);

export class Gen {
  /* theme · gen: 'H' or 'N' · color: override the generation's own · metal: v => v */
  constructor({ theme, gen = 'H', color, metal = v => v }) {
    const T = this.theme = theme;
    this.gen = gen;
    this.color = new THREE.Color(color !== undefined ? color : (gen === 'N' ? T.genN : T.crown)).getHex();
    this.units = Math.round(COMPUTE[gen]);         // one block per kH: H is 1, N is 2
    this.first = true;
    this.group = new THREE.Group();
    const add = m => { this.group.add(m); return m; };
    const std = (c, o = {}) => new THREE.MeshStandardMaterial({
      color: c, roughness: o.rough ?? 0.62, metalness: metal(o.metal ?? 0.3),
      emissive: o.emissive ?? 0x000000, emissiveIntensity: (o.emi ?? 0) * T.emissive });

    this.deck = add(new THREE.Mesh(deckGeo, std(T.pad, { rough: 0.92, metal: 0.1 })));
    this.deck.receiveShadow = true;

    // the unit itself: one block per kH, standing together on the deck
    this.blocks = [];
    this.ghosts = [];
    for (let i = 0; i < this.units; i++) {
      const x = (i - (this.units - 1) / 2) * (UNIT + UNIT_GAP);
      const b = add(new THREE.Mesh(unitGeo, std(T.shed, { rough: 0.6, metal: 0.35 })));
      b.position.set(x, DECK, -0.6);
      b.castShadow = b.receiveShadow = true;
      const band = add(new THREE.Mesh(bandGeo, std(this.color, {
        emissive: this.color, emi: 0.7, rough: 0.4 })));
      band.position.set(x, DECK + UNIT * 0.74, -0.6);
      // not launched yet: the same block as an outline
      const g = add(new THREE.LineSegments(unitEdges, new THREE.LineBasicMaterial({
        color: this.color, transparent: true, opacity: 0.45 })));
      g.position.set(x, DECK, -0.6);
      g.visible = false;
      this.blocks.push({ body: b, band });
      this.ghosts.push(g);
    }

    // what one unit is worth, counted out in front
    this.value = [];
    for (let i = 0; i < 12; i++) {
      const v = add(new THREE.Mesh(valGeo, std(this.color, { rough: 0.6, metal: 0.2 })));
      v.position.set(0, DECK, 2.6);
      v.visible = false;
      this.value.push(v);
    }
  }

  /* d: month (int, may be fractional) · launch (month gen N arrives, or null)
        exportActive is accepted and ignored — it throttles the fab, not the product   */
  update(d, time) {
    const T = this.theme;
    const { month = 0, launch = null } = d;
    const gen = this.gen;
    const launched = launch !== null && month >= launch;
    const exists = gen === 'H' ? true : launched;
    const onSale = gen === 'H' ? !launched : launched;
    const mv = marketValue(gen, month, launch);
    const pulse = 0.6 + 0.12 * Math.sin(time * 1.5);

    for (let i = 0; i < this.blocks.length; i++) {
      const { body, band } = this.blocks[i];
      body.visible = band.visible = exists;
      this.ghosts[i].visible = !exists;
      // the band is the generation's own colour while you can still buy it
      band.material.color.lerp(new THREE.Color(onSale ? this.color : T.towerOff), 0.1);
      band.material.emissive.lerp(new THREE.Color(onSale ? this.color : 0x000000), 0.1);
      band.material.emissiveIntensity = (onSale ? pulse : 0) * T.emissive;
    }

    // the value, one small block to every $5M — the launch cliff takes two fifths of it
    const n = exists ? clamp(Math.round(mv / PER_BLOCK), 0, this.value.length) : 0;
    const worn = mv < GPU_PRICE[gen] * 0.45
      ? (mv < GPU_PRICE[gen] * 0.3 ? STATUS.critical : STATUS.serious) : this.color;
    for (let i = 0; i < this.value.length; i++) {
      const v = this.value[i];
      v.visible = i < n;
      if (!v.visible) continue;
      v.position.x = (i - (n - 1) / 2) * VAL_PITCH;
      v.material.color.set(worn);
      v.material.emissive.set(worn);
      v.material.emissiveIntensity = 0.3 * T.emissive;
    }

    this.first = false;
  }
}
