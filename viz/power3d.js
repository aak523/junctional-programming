/* A power contract, as an object.

   An electrical tower and the line off it. You do not build a power station in this game
   — you sign for grid capacity at a site and then wait for it, so the object is the thing
   that arrives at the end of that wait: a steel lattice tower carrying a line. For the
   whole lead time it is only an outline on the ground with a row of blocks counting out
   the months; on its energisation month it goes solid and the line comes alive, and from
   that month it bills you whether or not you have any hardware for it to carry.

   Built here, on its own, so it can be worked on alone (viz/power.html) and dropped onto
   the sphere by the caller (viz/world3d.js), which positions it and owns its labels.

   Read it as a gauge:
     tower height   = the megawatts contracted      · outline = signed, not yet live
     blocks         = the months still to wait before it energises
     line, lit      = the MW actually carrying hardware (gen N takes them first)
     line, orange   = MW energised with nothing to power — charged all the same
     term strip     = every month it bills for; amber past month 23 is settlement only
     red run        = months the site still holds hardware after the contract has ended  */
import * as THREE from 'three';
import { STATUS } from './campus3d.js';

// --- the real constants, from world.py --------------------------------------------------
export const POWER_TERM = 24;                                    // months, exclusive end
export const T_HORIZON = 24;                                     // months 0..23; past it, settlement
export const POWER_COST = { us: 0.15, eu: 0.20, ap: 0.12 };      // $M per MW-month
export const POWER_MW = { H: 1.4, N: 1.6 };                      // MW per thousand GPUs
export const POWER_LEAD = { us: [3, 8], eu: [4, 9], ap: [2, 6] };// lead range, pre-drawn per site

// --- dimensions -------------------------------------------------------------------------
export const DECK = 0.5;          // apron thickness, as the campus
export const MONTH = 0.62;        // world units per month along the term strip
export const TOWER_H = 13.0;      // the tower at the reference contract
export const REF_MW = 14;         // the contract size the tower is drawn at 1.0
export const BASE_W = 3.0;        // leg spread at the ground
export const WAIST_W = 1.25;      // and at the shoulders, where the arms start
export const ARM_SPAN = 5.2;      // the widest crossarm
export const MW_LINE = 0.40;      // world units of conductor per MW
export const PAD_R = 13.0;        // the footprint a caller should leave

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/* world.py powers gen N first, then gives gen H whatever megawatts are left. */
export function carried(mw, ownedH, ownedN) {
  const n = Math.min(ownedN, mw / POWER_MW.N);
  const h = Math.min(ownedH, (mw - n * POWER_MW.N) / POWER_MW.H);
  return n * POWER_MW.N + h * POWER_MW.H;
}

// --- geometry built once and shared ------------------------------------------------------
const padGeo = new THREE.BoxGeometry(1, DECK, 1);
padGeo.translate(0, DECK / 2, 0);
const barGeo = new THREE.BoxGeometry(1, 1, 1);          // every strut is a scaled unit box
const insGeo = new THREE.CylinderGeometry(0.075, 0.075, 1, 7, 1);
insGeo.translate(0, -0.5, 0);                            // hangs from the arm
const lineGeo = new THREE.BoxGeometry(1, 0.11, 0.11);
lineGeo.translate(0.5, 0, 0);
const blockGeo = new THREE.BoxGeometry(0.44, 0.44, 0.44);
blockGeo.translate(0, 0.22, 0);
const tickGeo = new THREE.BoxGeometry(MONTH * 0.78, 0.3, 1.1);
tickGeo.translate(0, 0.15, 0);

const LEVELS = [0, 0.2, 0.38, 0.55, 0.74, 1.0];
const ARMS = [[0.78, 1.0], [0.88, 0.78], [0.97, 0.52]];

/* the tower's half-width at a height fraction: a wide splayed base drawn in to the
   shoulders, then parallel up to the peak — the shape of a lattice pylon */
const halfW = t => (t < 0.55
  ? (BASE_W - (BASE_W - WAIST_W) * (t / 0.55)) / 2
  : WAIST_W / 2);

export class Power {
  /* theme · color: the site's own · metal: v => v so a paper key flattens metalness */
  constructor({ theme, color, metal = v => v }) {
    const T = this.theme = theme;
    this.color = color;
    this.scaleNow = 1;
    this.first = true;
    this.group = new THREE.Group();
    const add = (m, p = this.group) => { p.add(m); return m; };
    const std = (c, o = {}) => new THREE.MeshStandardMaterial({
      color: c, roughness: o.rough ?? 0.6, metalness: metal(o.metal ?? 0.45),
      emissive: o.emissive ?? 0x000000, emissiveIntensity: (o.emi ?? 0) * T.emissive });

    this.pad = add(new THREE.Mesh(padGeo, std(T.pad, { rough: 0.92, metal: 0.1 })));
    this.pad.scale.set(PAD_R * 2, 1, 17);
    this.pad.position.z = 1.5;
    this.pad.receiveShadow = true;

    // --- the tower, in one group so the whole thing scales with the contract
    this.tower = add(new THREE.Group());
    this.tower.position.set(0, DECK, -2.6);
    this.steel = [];                                     // every solid member, hidden when unbuilt
    const steelMat = std(T.steel, { rough: 0.55, metal: 0.55 });
    const strut = (x, y, z, sx, sy, sz) => {
      const m = add(new THREE.Mesh(barGeo, steelMat), this.tower);
      m.position.set(x, y, z);
      m.scale.set(sx, sy, sz);
      m.castShadow = true;
      this.steel.push(m);
      return m;
    };

    // four legs, splayed at the foot and drawn in to the shoulders
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      for (let i = 0; i < LEVELS.length - 1; i++) {
        const t0 = LEVELS[i], t1 = LEVELS[i + 1];
        const w0 = halfW(t0) * sx, w1 = halfW(t1) * sx;
        const y0 = t0 * TOWER_H, y1 = t1 * TOWER_H;
        const dx = w1 - w0, dy = y1 - y0;
        const m = strut((w0 + w1) / 2, (y0 + y1) / 2, sz * halfW((t0 + t1) / 2),
                        0.12, Math.hypot(dx, dy), 0.12);
        m.rotation.z = -Math.atan2(dx, dy);
      }
    }
    // a belt at each level, and one diagonal per bay, so it reads as lattice
    for (let i = 0; i < LEVELS.length; i++) {
      const t = LEVELS[i], w = halfW(t) * 2, y = t * TOWER_H;
      for (const sz of [-1, 1]) strut(0, y, sz * halfW(t), w, 0.09, 0.09);
      for (const sx of [-1, 1]) strut(sx * halfW(t), y, 0, 0.09, 0.09, w);
      if (i < LEVELS.length - 1) {
        const t1 = LEVELS[i + 1], y1 = t1 * TOWER_H, h = y1 - y;
        for (const sz of [-1, 1]) {
          const m = strut(0, (y + y1) / 2, sz * halfW((t + t1) / 2),
                          0.07, Math.hypot(w, h), 0.07);
          m.rotation.z = Math.atan2(w, h) * (sz > 0 ? 1 : -1);
        }
      }
    }
    // three crossarms, with insulators hanging off their tips
    this.arms = [];
    for (const [t, span] of ARMS) {
      const y = t * TOWER_H;
      strut(0, y, 0, ARM_SPAN * span, 0.13, 0.13);
      for (const sx of [-1, 1]) {
        const ins = add(new THREE.Mesh(insGeo, std(T.trim, { rough: 0.4, metal: 0.3 })), this.tower);
        ins.position.set(sx * ARM_SPAN * span / 2, y, 0);
        ins.scale.y = 0.75;
        this.steel.push(ins);
      }
      this.arms.push(y);
    }

    // signed but not built: the same silhouette as a coarse outline on the ground
    this.ghost = add(new THREE.Group(), this.tower);
    {
      const pts = [];
      for (const sx of [-1, 1]) for (const sz of [-1, 1])
        for (let i = 0; i < LEVELS.length - 1; i++) {
          const t0 = LEVELS[i], t1 = LEVELS[i + 1];
          pts.push(sx * halfW(t0), t0 * TOWER_H, sz * halfW(t0),
                   sx * halfW(t1), t1 * TOWER_H, sz * halfW(t1));
        }
      for (const t of LEVELS) for (const sz of [-1, 1])
        pts.push(-halfW(t), t * TOWER_H, sz * halfW(t), halfW(t), t * TOWER_H, sz * halfW(t));
      for (const [t, span] of ARMS)
        pts.push(-ARM_SPAN * span / 2, t * TOWER_H, 0, ARM_SPAN * span / 2, t * TOWER_H, 0);
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      this.ghost.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({
        color: STATUS.warning, transparent: true, opacity: 0.5 })));
    }

    // --- the line leaving the tower: lit for MW carrying hardware, orange for MW burning
    this.lineLive = add(new THREE.Mesh(lineGeo, std(color, { emissive: color, emi: 0.8, rough: 0.4 })));
    this.lineDead = add(new THREE.Mesh(lineGeo, std(STATUS.serious, {
      emissive: STATUS.serious, emi: 0.75, rough: 0.4 })));

    // --- the wait: one block per month of lead, filling as the months pass
    this.waitBlocks = [];
    for (let i = 0; i < 10; i++) {
      const b = add(new THREE.Mesh(blockGeo, std(STATUS.warning, { rough: 0.6, metal: 0.2 })));
      b.position.set(0, DECK, 3.4);
      b.visible = false;
      this.waitBlocks.push(b);
    }

    // --- the term strip: one tick per month this contract bills for
    this.ticks = [];
    for (let i = 0; i < 40; i++) {
      const t = add(new THREE.Mesh(tickGeo, std(T.sub, { rough: 0.8, metal: 0.1 })));
      t.position.set(0, DECK, 6.4);
      t.visible = false;
      this.ticks.push(t);
    }
  }

  /* d: mw (MW) · start (the energisation month) · end (exclusive) · site · month
        signed (the month it was signed; start - lead) · ownedH, ownedN (thousands at the
        site, optional — what the contract has to power)                              */
  update(d, time) {
    const T = this.theme;
    const { mw, start, end, site, month, signed = start, ownedH = 0, ownedN = 0 } = d;
    const ease = this.first ? 1 : 0.12;
    const live = month >= start && month < end;
    const waiting = month < start;
    const used = carried(mw, ownedH, ownedN);
    const pulse = 0.5 + 0.3 * Math.sin(time * 1.6);

    // the tower is as tall as the contract is big
    const want = clamp(Math.sqrt(mw / REF_MW), 0.55, 1.6);
    this.scaleNow += (want - this.scaleNow) * ease;
    this.tower.scale.setScalar(this.scaleNow);

    for (const m of this.steel) m.visible = !waiting;
    this.ghost.visible = waiting;

    // the line out of the tower, hung at the lowest crossarm
    const lit = live ? used * MW_LINE : 0;
    const dead = live ? Math.max(0, mw - used) * MW_LINE : 0;
    const y = DECK + this.arms[0] * this.scaleNow;
    const x0 = ARM_SPAN * 0.5 * this.scaleNow;
    this.lineLive.visible = lit > 0.02;
    this.lineLive.scale.x = Math.max(0.02, lit);
    this.lineLive.position.set(x0, y, -2.6);
    this.lineDead.visible = dead > 0.02;
    this.lineDead.scale.x = Math.max(0.02, dead);
    this.lineDead.position.set(x0 + lit, y, -2.6);
    this.lineDead.material.emissiveIntensity = (0.5 + 0.35 * pulse) * T.emissive;

    // the wait: a block per month of lead, pale once that month is behind you
    const lead = Math.max(0, start - signed);
    const shown = Math.min(lead, this.waitBlocks.length);
    for (let i = 0; i < this.waitBlocks.length; i++) {
      const b = this.waitBlocks[i];
      const on = waiting && i < shown;
      b.visible = on;
      if (!on) continue;
      const done = signed + i < month;
      b.position.x = (i - (shown - 1) / 2) * 0.62;
      b.material.color.set(done ? T.towerOff : STATUS.warning);
      b.material.emissive.set(done ? 0x000000 : STATUS.warning);
      b.material.emissiveIntensity = (done ? 0 : 0.55) * T.emissive;
    }

    // the term strip: every month this contract bills for, amber past the horizon, and a
    // red run for months the site still holds hardware once the contract has ended
    const hasKit = ownedH + ownedN > 0.01;
    const stranded = hasKit ? Math.max(0, T_HORIZON - end) : 0;
    const total = Math.min(this.ticks.length, (end - start) + stranded);
    for (let i = 0; i < this.ticks.length; i++) {
      const t = this.ticks[i];
      t.visible = i < total;
      if (!t.visible) continue;
      const m = start + i;
      t.position.x = (i - (total - 1) / 2) * MONTH;
      const past = m >= end;                       // the contract is over, the kit is not
      const beyond = m >= T_HORIZON;               // settlement, never capacity
      const c = past ? STATUS.critical : beyond ? STATUS.warning : (m <= month ? this.color : T.sub);
      t.material.color.set(c);
      t.material.emissive.set(past || beyond ? c : 0x000000);
      t.material.emissiveIntensity = (past ? 0.8 : beyond ? 0.4 : 0) * T.emissive;
      t.scale.y = past || m <= month ? 1 : 0.5;    // months already charged stand taller
    }

    this.first = false;
  }
}
