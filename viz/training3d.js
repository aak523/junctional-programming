/* The three training runs, as an object.

   Three sand timers in a row, one per window, standing in yokes they can turn in. A
   timer's glass holds exactly what its window needs — 60, 140 and 320 kH-months, drawn
   at one scale, so the last run towers over the first and you can see at a glance that
   it is the hard one.

   The sand in the upper bulb is what the window still needs; the pile in the lower bulb
   is what the lab has already run. While a window is open its timer stands upright and
   the sand falls. The month the window closes the timer turns over in its yoke and locks
   — green if it was met, red if it was not, and any sand left in the glass at that moment
   is the shortfall you are about to be billed for, at $5M a kH-month on top of the $200M
   for missing it at all. A window that has not opened yet lies on its side, untouched.

   Built here, on its own, so it can be worked on alone (viz/training.html) and dropped
   into a page by the caller, which positions it and owns its labels.

   Read it as a gauge:
     glass size   = what the window needs   · upper sand = what it still needs
     lower pile   = what has been run       · falling    = the window is open now
     turned, green = met · turned, red = missed, and the sand left in it is the shortfall */
import * as THREE from 'three';
import { STATUS } from './campus3d.js';

// --- the real constants, from world.py --------------------------------------------------
export const MILESTONES = [[0, 7, 60.0], [8, 15, 140.0], [16, 23, 320.0]];  // first, last, kH-months
export const MISS_PENALTY = 200.0;       // $M per window missed
export const SHORTFALL_COST = 5.0;       // $M per kH-month short

// --- dimensions -------------------------------------------------------------------------
export const DECK = 0.5;          // plinth thickness, as the campus apron
export const KHM = 0.032;         // world units of glass per kH-month — one scale for all three
export const R_FRAC = 0.26;       // a timer's radius, as a fraction of its height
export const GAP = 2.2;           // between the glasses
export const GANTRY_Y = Math.max(...MILESTONES.map(m => m[2])) * KHM;   // the tallest glass

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/* The hourglass, as a unit-height profile: two bulbs pinched at the waist. On a black
   ground a transparent shell is simply not there, so the glass is drawn — ribs down the
   silhouette and hoops round it — over a very faint surface. */
const PROFILE = [[0.46, 0], [0.47, 0.07], [0.41, 0.24], [0.10, 0.45], [0.055, 0.5],
                 [0.10, 0.55], [0.41, 0.76], [0.47, 0.93], [0.46, 1.0]];
const glassGeo = new THREE.LatheGeometry(PROFILE.map(([r, y]) => new THREE.Vector2(r, y)), 26);
const ribGeo = (() => {
  const pts = [];
  for (let k = 0; k < 10; k++) {                       // ten ribs round the glass
    const a = (k / 10) * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
    for (let i = 0; i < PROFILE.length - 1; i++) {
      const [r0, y0] = PROFILE[i], [r1, y1] = PROFILE[i + 1];
      pts.push(r0 * ca, y0, r0 * sa, r1 * ca, y1, r1 * sa);
    }
  }
  for (const [r, y] of [PROFILE[0], PROFILE[4], PROFILE[8]]) {   // hoops: foot, waist, lip
    const N = 26;
    for (let k = 0; k < N; k++) {
      const a0 = (k / N) * Math.PI * 2, a1 = ((k + 1) / N) * Math.PI * 2;
      pts.push(r * Math.cos(a0), y, r * Math.sin(a0), r * Math.cos(a1), y, r * Math.sin(a1));
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  return g;
})();
const capGeo = new THREE.CylinderGeometry(0.52, 0.52, 0.07, 26, 1);
const postGeo = new THREE.BoxGeometry(0.1, 1, 0.1);
postGeo.translate(0, 0.5, 0);
const plinthGeo = new THREE.BoxGeometry(1, DECK, 1);
plinthGeo.translate(0, DECK / 2, 0);
// sand: a cone hanging from the waist above, and a pile growing from the base below
const coneGeo = new THREE.ConeGeometry(1, 1, 22);
const streamGeo = new THREE.CylinderGeometry(0.035, 0.035, 1, 8);
streamGeo.translate(0, 0.5, 0);

export class Training {
  /* theme: the key's colours · color: the run colour · metal: v => v */
  constructor({ theme, color, metal = v => v }) {
    const T = this.theme = theme;
    this.color = color !== undefined ? color : T.crown;
    this.first = true;
    this.group = new THREE.Group();
    const add = (m, p = this.group) => { p.add(m); return m; };
    const std = (c, o = {}) => new THREE.MeshStandardMaterial({
      color: c, roughness: o.rough ?? 0.6, metalness: metal(o.metal ?? 0.3),
      emissive: o.emissive ?? 0x000000, emissiveIntensity: (o.emi ?? 0) * T.emissive });

    // lay the three out side by side, each as wide as its own glass needs
    const H = MILESTONES.map(m => m[2] * KHM);
    const W = H.map(h => h * R_FRAC * 2);
    const span = W.reduce((a, w) => a + w, 0) + GAP * (W.length - 1);
    let x = -span / 2;

    this.plinth = add(new THREE.Mesh(plinthGeo, std(T.pad, { rough: 0.92, metal: 0.1 })));
    this.plinth.scale.set(span + 5, 1, Math.max(...W) + 5);
    this.plinth.receiveShadow = true;

    this.timers = MILESTONES.map(([, , target], i) => {
      const h = H[i], r = h * R_FRAC;
      const cx = x + W[i] / 2;
      x += W[i] + GAP;

      // the yoke: two posts and a pin the glass turns on
      const yoke = add(new THREE.Group());
      yoke.position.set(cx, DECK, 0);
      for (const s of [-1, 1]) {
        const post = add(new THREE.Mesh(postGeo, std(T.steel, { rough: 0.5, metal: 0.6 })), yoke);
        post.position.set(0, 0, s * (r + 0.34));
        post.scale.set(r * 0.1 + 0.16, h + 1.0, r * 0.1 + 0.16);
      }

      // everything that turns lives in here
      const turn = add(new THREE.Group(), yoke);
      turn.position.y = h / 2 + 0.3;

      const shell = add(new THREE.Mesh(glassGeo, new THREE.MeshStandardMaterial({
        color: T.hub, roughness: 0.1, metalness: metal(0.1),
        transparent: true, opacity: 0.1, side: THREE.DoubleSide })), turn);
      shell.scale.set(r / 0.47, h, r / 0.47);
      shell.position.y = -h / 2;
      const ribs = add(new THREE.LineSegments(ribGeo, new THREE.LineBasicMaterial({
        color: T.trim, transparent: true, opacity: 0.55 })), turn);
      ribs.scale.copy(shell.scale);
      ribs.position.y = -h / 2;

      for (const s of [-1, 1]) {
        const cap = add(new THREE.Mesh(capGeo, std(T.trim, { rough: 0.5, metal: 0.45 })), turn);
        cap.scale.set(r / 0.52 * 0.92, 1.6, r / 0.52 * 0.92);
        cap.position.y = s > 0 ? h / 2 : -h / 2;
      }

      // the sand still owed, hanging point-down from the waist
      const owed = add(new THREE.Mesh(coneGeo, std(this.color, {
        emissive: this.color, emi: 0.35, rough: 0.8, metal: 0.05 })), turn);
      owed.rotation.x = Math.PI;                 // apex down, at the neck
      // the sand already run, piled on the floor of the lower bulb
      const done = add(new THREE.Mesh(coneGeo, std(this.color, {
        emissive: this.color, emi: 0.5, rough: 0.8, metal: 0.05 })), turn);

      const stream = add(new THREE.Mesh(streamGeo, std(this.color, {
        emissive: this.color, emi: 1.1, rough: 0.4 })), turn);
      stream.visible = false;

      // the verdict pin, driven into the yoke when the window closes
      const pin = add(new THREE.Mesh(capGeo, std(STATUS.good, { emissive: STATUS.good, emi: 0.9 })), yoke);
      pin.scale.set(r / 0.52 * 0.8, 1.6, r / 0.52 * 0.8);
      pin.position.y = h + 0.75;
      pin.visible = false;

      return { target, h, r, turn, owed, done, stream, pin, angle: Math.PI / 2, fill: 0 };
    });
  }

  /* d: month (int) · perMonth: [kH-months of training in each finished month]
        met: { 7: bool, 15: bool, 23: bool } — written once, as end_month writes it    */
  update(d, time) {
    const T = this.theme;
    const { month = 0 } = d;
    const perMonth = d.perMonth || [];
    const met = d.met || {};
    // the first frame lands on its values: a still of a state should not be mid-turn
    const ease = this.first ? 1 : 0.07;

    for (let i = 0; i < this.timers.length; i++) {
      const tm = this.timers[i];
      const [a, b, target] = MILESTONES[i];
      // only compute that falls inside the window counts for it — overshooting buys nothing
      let run = 0;
      for (let k = a; k <= Math.min(b, perMonth.length - 1); k++) run += perMonth[k] || 0;
      const open = month >= a && month <= b;
      const sealed = month > b;
      const hit = sealed ? (met[b] ?? run >= target) : false;

      // the glass turns: on its side before it opens, upright while it runs, over once sealed
      const want = sealed ? Math.PI : (open ? 0 : Math.PI / 2);
      tm.angle += (want - tm.angle) * ease;
      tm.turn.rotation.z = tm.angle;

      // the sand: what is still owed above, what has been run below
      const f = clamp(run / target, 0, 1);
      tm.fill += (f - tm.fill) * (this.first ? 1 : 0.1);
      const owed = 1 - tm.fill, h = tm.h, r = tm.r;

      tm.owed.visible = owed > 0.004;
      tm.owed.scale.set(r * 0.86 * Math.cbrt(owed), h * 0.42 * owed, r * 0.86 * Math.cbrt(owed));
      tm.owed.position.y = -h / 2 + h * 0.5 + (h * 0.42 * owed) / 2;
      // sand that never ran is the shortfall, and it is billed
      const short = sealed && !hit;
      tm.owed.material.color.lerp(new THREE.Color(short ? STATUS.critical : this.color), 0.1);
      tm.owed.material.emissive.lerp(new THREE.Color(short ? STATUS.critical : this.color), 0.1);
      tm.owed.material.emissiveIntensity = (short ? 0.9 : 0.35) * T.emissive;

      tm.done.visible = tm.fill > 0.004;
      tm.done.scale.set(r * 0.92 * Math.cbrt(tm.fill), h * 0.40 * tm.fill, r * 0.92 * Math.cbrt(tm.fill));
      tm.done.position.y = -h / 2 + (h * 0.40 * tm.fill) / 2;

      // it only runs while the window is open and there is something left to run
      tm.stream.visible = open && owed > 0.004;
      if (tm.stream.visible) {
        tm.stream.scale.y = h * 0.42 * tm.fill + 0.1;
        tm.stream.position.y = -h / 2 + h * 0.40 * tm.fill;
        tm.stream.material.emissiveIntensity = (0.9 + 0.3 * Math.sin(time * 7 + i)) * T.emissive;
      }

      tm.pin.visible = sealed;
      if (sealed) {
        const c = hit ? STATUS.good : STATUS.critical;
        tm.pin.material.color.set(c);
        tm.pin.material.emissive.set(c);
        tm.pin.material.emissiveIntensity = 0.9 * T.emissive;
      }
    }
    this.first = false;
  }
}
