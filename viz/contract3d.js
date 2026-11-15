/* A reserved-capacity contract, as an object.

   A sheet of paper, floating. Everything else in this world is a thing you can walk up
   to — a shed, a factory, a shop, a tower. A contract is not: it is a piece of paper that
   says you will pay a fixed price for a fixed amount of capacity for a fixed number of
   months, and nothing about it changes once it is signed. So it is drawn flat, hanging in
   the air over its site, turning to face you wherever you stand.

   The marks on it are the whole deal:
     the squares     what you got, one to the kH — an outline for any part of your ask
                     the month's cap would not fill
     the row beneath one mark per month it runs, lit once charged; the amber ones run
                     past month 23, where they buy no capacity and are only a bill
     the seal        the site it is bound to, in that site's colour

   Built here, on its own, so it can be worked on alone (viz/contract.html) and dropped
   into a page by the caller, which positions it and owns its labels.                    */
import * as THREE from 'three';
import { STATUS } from './campus3d.js';

// --- the real constants, from world.py --------------------------------------------------
export const T_HORIZON = 24;      // months 0..23; a month past it is settlement only
export const TERM_FACTOR = { 6: 1.15, 12: 1.00, 24: 0.90 };
export const SITE_PRICE = { us: 1.00, eu: 1.10, ap: 0.95 };

// --- dimensions -------------------------------------------------------------------------
export const CARD_W = 9.0;        // the sheet
export const CARD_H = 6.2;
export const FLOAT_Y = 4.6;       // how high it hangs
export const SQ = 0.78;           // a kH square
export const SQ_GAP = 0.2;
export const TICK_W = 0.26;       // a month mark
export const TICK_GAP = 0.1;
export const PAD_R = 7.0;

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// --- geometry built once and shared ------------------------------------------------------
const planeGeo = new THREE.PlaneGeometry(1, 1);
const ringGeo = new THREE.RingGeometry(0.34, 0.46, 24);
const discGeo = new THREE.CircleGeometry(0.34, 24);

export class Contract {
  /* theme · color: the site's own · metal is accepted and ignored — paper is not metal */
  constructor({ theme, color }) {
    const T = this.theme = theme;
    this.color = color;
    this.group = new THREE.Group();
    // the card and everything on it live in one group, so the whole sheet turns together
    this.card = new THREE.Group();
    this.card.position.y = FLOAT_Y;
    this.group.add(this.card);
    const flat = (c, o = {}) => new THREE.MeshBasicMaterial({
      color: c, transparent: true, opacity: o.op ?? 1, side: THREE.DoubleSide });
    const on = (geo, mat, z = 0) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.z = z;
      this.card.add(m);
      return m;
    };

    // the sheet itself, with a hairline border a shade darker
    this.sheet = on(planeGeo, flat(T.bloom ? T.hub : 0xffffff, { op: T.bloom ? 0.92 : 1 }), 0);
    this.sheet.scale.set(CARD_W, CARD_H, 1);
    this.border = on(planeGeo, flat(T.trim, { op: 0.55 }), -0.01);
    this.border.scale.set(CARD_W + 0.16, CARD_H + 0.16, 1);

    // a rule under the heading, so the sheet reads as a document and not a tile
    this.rule = on(planeGeo, flat(T.muted ?? T.trim, { op: 0.5 }), 0.01);
    this.rule.scale.set(CARD_W - 1.4, 0.05, 1);
    this.rule.position.set(0, CARD_H / 2 - 1.5, 0.01);

    // the seal: the site this contract is bound to, and cannot be moved from
    this.seal = on(discGeo, flat(color, { op: 0.9 }), 0.02);
    this.seal.position.set(CARD_W / 2 - 1.0, CARD_H / 2 - 0.85, 0.02);
    this.sealRing = on(ringGeo, flat(color, { op: 0.55 }), 0.02);
    this.sealRing.position.copy(this.seal.position);
    this.sealRing.scale.setScalar(1.5);

    // the quantity, in squares
    this.squares = [];
    for (let i = 0; i < 10; i++) {
      const sq = on(planeGeo, flat(color, { op: 1 }), 0.02);
      sq.scale.set(SQ, SQ, 1);
      sq.visible = false;
      const gh = on(planeGeo, flat(STATUS.critical, { op: 0.42 }), 0.015);
      gh.scale.set(SQ, SQ, 1);
      gh.visible = false;
      this.squares.push({ sq, gh });
    }

    // the term, in month marks
    this.ticks = [];
    for (let i = 0; i < 30; i++) {
      const t = on(planeGeo, flat(T.trim, { op: 1 }), 0.02);
      t.scale.set(TICK_W, 0.9, 1);
      t.visible = false;
      this.ticks.push(t);
    }
  }

  /* d: qty · price · start · end (exclusive) · site · month · ask · got
        camera: optional — pass it and the sheet turns to face wherever you are     */
  update(d, time) {
    const T = this.theme;
    const { start = 0, end = 0, month = 0 } = d;
    const got = d.got ?? d.qty ?? 0;
    const ask = d.ask ?? got;

    // it hangs, and it turns to face you
    this.card.position.y = FLOAT_Y + Math.sin(time * 0.7) * 0.22;
    if (d.camera) this.card.quaternion.copy(d.camera.quaternion);

    // the quantity: filled squares for what you got, outlines for what the cap refused
    const nGot = clamp(Math.round(got), 0, this.squares.length);
    const nAsk = clamp(Math.round(ask), 0, this.squares.length);
    const n = Math.max(nGot, nAsk);
    const row = -(n - 1) / 2 * (SQ + SQ_GAP);
    const yQty = CARD_H / 2 - 3.0;
    for (let i = 0; i < this.squares.length; i++) {
      const { sq, gh } = this.squares[i];
      sq.visible = i < nGot;
      gh.visible = i >= nGot && i < nAsk;
      const x = row + i * (SQ + SQ_GAP);
      sq.position.set(x, yQty, 0.02);
      gh.position.set(x, yQty, 0.015);
    }

    // the term: one mark per month, lit once charged, amber where it outlives the game
    const total = clamp(end - start, 0, this.ticks.length);
    const tRow = -(total - 1) / 2 * (TICK_W + TICK_GAP);
    const yTerm = -CARD_H / 2 + 1.25;
    for (let i = 0; i < this.ticks.length; i++) {
      const t = this.ticks[i];
      t.visible = i < total;
      if (!t.visible) continue;
      const m = start + i;
      const beyond = m >= T_HORIZON;             // bought nothing; settled at the end
      const charged = m <= month;
      t.position.set(tRow + i * (TICK_W + TICK_GAP), yTerm, 0.02);
      t.scale.set(TICK_W, beyond ? 1.05 : (charged ? 0.9 : 0.5), 1);
      t.material.color.set(beyond ? STATUS.warning : (charged ? this.color : T.trim));
      t.material.opacity = beyond ? 0.95 : (charged ? 0.95 : 0.35);
    }
  }
}
