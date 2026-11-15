/* The spot market, as an object.

   A tap over a bucket. You open the tap as far as you like and leave it open — it is a
   standing request, not an order — and then you take whatever actually comes out. Some
   months that is everything you asked for; some months it is a dribble, and nothing
   tells you why.

   The handle angle is what you set. The bucket fills with what arrived. The ring round
   the bucket is where your ask would have reached: when the water stops short of it,
   that gap is the shortfall, and it turns red.

   Built here, on its own, so it can be worked on alone (viz/spot.html) and dropped into
   a page by the caller, which positions it and owns its labels.                        */
import * as THREE from 'three';
import { STATUS } from './campus3d.js';

// --- the real constants, from world.py --------------------------------------------------
export const SPOT_CAP = { loose: { us: 5.0, eu: 4.0, ap: 3.0 },
                          tight: { us: 1.5, eu: 1.0, ap: 0.5 } };   // kH a month
export const SPOT_MULT = { loose: 1.1, tight: 1.8 };
export const SITE_PRICE = { us: 1.00, eu: 1.10, ap: 0.95 };
export const SPIKE_CAP = 0.5;         // a rival lab buying halves what is on offer
export const SPIKE_PRICE = 1.5;
export const EXPORT_CAP = 0.6;        // export controls take a further 40% of supply

/* what the month will actually give you, and what it charges — the world's own formulas */
export const capOf = (site, regime, spike, exportActive) =>
  SPOT_CAP[regime][site] * (spike ? SPIKE_CAP : 1) * (exportActive ? EXPORT_CAP : 1);
export const priceOf = (cindex, regime, noise, spike, site) =>
  cindex * SPOT_MULT[regime] * noise * (spike ? SPIKE_PRICE : 1) * SITE_PRICE[site];

// --- dimensions -------------------------------------------------------------------------
export const DECK = 0.5;          // plinth thickness, as the campus apron
export const KH = 0.85;           // world units of bucket per kH
export const BUCKET_R = 1.8;
export const SPOUT_Y = 7.6;       // how high the tap stands over the bucket
export const RISER_X = -4.0;      // and how far back, clear of the bucket
export const PAD_R = 8.0;

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// --- geometry built once and shared ------------------------------------------------------
const padGeo = new THREE.BoxGeometry(1, DECK, 1);
padGeo.translate(0, DECK / 2, 0);
const riserGeo = new THREE.CylinderGeometry(0.34, 0.34, 1, 14, 1);
riserGeo.translate(0, 0.5, 0);
const spoutGeo = new THREE.CylinderGeometry(0.26, 0.26, Math.abs(RISER_X) + 0.1, 12, 1);
spoutGeo.rotateZ(Math.PI / 2);
const nozzleGeo = new THREE.CylinderGeometry(0.3, 0.22, 0.5, 12, 1);
const handleGeo = new THREE.BoxGeometry(1.9, 0.16, 0.3);
const hubGeo = new THREE.CylinderGeometry(0.22, 0.22, 0.36, 12, 1);
hubGeo.rotateX(Math.PI / 2);
// the bucket, as a ring of staves so its contents can be seen
const bucketGeo = new THREE.CylinderGeometry(BUCKET_R, BUCKET_R * 0.88, 1, 22, 1, true);
bucketGeo.translate(0, 0.5, 0);
const fillGeo = new THREE.CylinderGeometry(BUCKET_R * 0.94, BUCKET_R * 0.84, 1, 22, 1);
fillGeo.translate(0, 0.5, 0);
const markGeo = new THREE.TorusGeometry(BUCKET_R * 1.03, 0.07, 6, 28);
markGeo.rotateX(Math.PI / 2);
const streamGeo = new THREE.CylinderGeometry(0.12, 0.12, 1, 8);
streamGeo.translate(0, -0.5, 0);      // hangs down from the nozzle

export class Spot {
  /* theme · color: the site's own · metal: v => v so a paper key flattens metalness */
  constructor({ theme, color, metal = v => v }) {
    const T = this.theme = theme;
    this.color = color;
    this.fill = 0; this.angle = 0;
    this.first = true;
    this.group = new THREE.Group();
    const add = m => { this.group.add(m); return m; };
    const std = (c, o = {}) => new THREE.MeshStandardMaterial({
      color: c, roughness: o.rough ?? 0.5, metalness: metal(o.metal ?? 0.5),
      emissive: o.emissive ?? 0x000000, emissiveIntensity: (o.emi ?? 0) * T.emissive,
      transparent: o.trans ?? false, opacity: o.op ?? 1 });

    this.pad = add(new THREE.Mesh(padGeo, std(T.pad, { rough: 0.92, metal: 0.1 })));
    this.pad.scale.set(PAD_R * 2, 1, PAD_R * 2);
    this.pad.receiveShadow = true;

    // the tap
    const riser = add(new THREE.Mesh(riserGeo, std(T.steel, { rough: 0.45, metal: 0.6 })));
    riser.position.set(RISER_X, DECK, 0);
    riser.scale.y = SPOUT_Y;
    riser.castShadow = true;
    const spout = add(new THREE.Mesh(spoutGeo, std(T.steel, { rough: 0.45, metal: 0.6 })));
    spout.position.set(RISER_X / 2 + 0.05, DECK + SPOUT_Y, 0);
    const nozzle = add(new THREE.Mesh(nozzleGeo, std(T.steel, { rough: 0.45, metal: 0.6 })));
    nozzle.position.set(0.05, DECK + SPOUT_Y - 0.3, 0);
    const hub = add(new THREE.Mesh(hubGeo, std(T.trim, { rough: 0.4, metal: 0.5 })));
    hub.position.set(RISER_X, DECK + SPOUT_Y, 0.34);
    // the handle: its angle is the level you have left the tap at
    this.handle = add(new THREE.Mesh(handleGeo, std(T.trim, { rough: 0.4, metal: 0.45 })));
    this.handle.position.set(RISER_X, DECK + SPOUT_Y, 0.52);

    // what comes out
    this.stream = add(new THREE.Mesh(streamGeo, std(this.color, {
      emissive: this.color, emi: 1.0, rough: 0.3, trans: true, op: 0.85 })));
    this.stream.position.set(0.05, DECK + SPOUT_Y - 0.55, 0);
    this.stream.visible = false;

    // the bucket, what is in it, and the ring at what you asked for
    this.bucket = add(new THREE.Mesh(bucketGeo, std(T.sub, { rough: 0.7, metal: 0.3 })));
    this.bucket.material.side = THREE.DoubleSide;
    this.bucket.position.set(0.05, DECK, 0);
    this.bucket.scale.y = 0.001;
    this.water = add(new THREE.Mesh(fillGeo, std(this.color, {
      emissive: this.color, emi: 0.55, rough: 0.4 })));
    this.water.position.set(0.05, DECK + 0.04, 0);
    this.water.scale.y = 0.001;
    this.mark = add(new THREE.Mesh(markGeo, std(T.tick, { emissive: T.tick, emi: 0.8 })));
    this.mark.position.set(0.05, DECK, 0);
  }

  /* d: site · level (kH you have the tap set to) · cap (kH the month will give)
        price and truth are accepted and ignored — this object is quantity only      */
  update(d, time) {
    const T = this.theme;
    const level = d.level ?? 0;
    const cap = d.cap ?? 0;
    const got = Math.min(level, cap);
    const short = Math.max(0, level - got);
    const ease = this.first ? 1 : 0.12;

    // the handle sits where you left it — a standing request, not an order
    const want = clamp(level / 6, 0, 1) * (Math.PI * 0.62);
    this.angle += (want - this.angle) * ease;
    this.handle.rotation.z = -this.angle;

    // the bucket is as deep as your ask; the water in it is what actually arrived
    const askH = Math.max(0.4, level * KH);
    this.bucket.scale.y = askH;
    this.mark.position.y = DECK + askH;
    const dry = short > 0.01;
    this.mark.material.color.set(dry ? STATUS.critical : T.tick);
    this.mark.material.emissive.set(dry ? STATUS.critical : T.tick);
    this.mark.material.emissiveIntensity = (dry ? 1.0 + 0.3 * Math.sin(time * 3) : 0.7) * T.emissive;

    this.fill += (got * KH - this.fill) * ease;
    this.water.visible = this.fill > 0.02;
    this.water.scale.y = Math.max(0.02, this.fill);

    // it only runs while there is anything to come
    this.stream.visible = got > 0.01;
    if (this.stream.visible) {
      this.stream.scale.y = Math.max(0.2, SPOUT_Y - 0.55 - this.fill);
      this.stream.scale.x = this.stream.scale.z = clamp(got / 3, 0.35, 1.3);
      this.stream.material.opacity = 0.6 + 0.25 * Math.abs(Math.sin(time * 5));
    }

    this.first = false;
  }
}
