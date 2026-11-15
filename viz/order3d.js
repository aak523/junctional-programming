/* An order in transit: GPUs bought from the fab or from a broker, riding the lane to a site.

   It is a consignment on a deck. The deck is what was paid for up front, the crates
   standing on it are the hardware still undelivered, and the empty outlines around them
   are the crates the allocation has already taken away. A vendor order is a train in a
   shared FIFO queue: chocked until it is eligible, then it crawls down the lane as the
   monthly allocation drips in, dropping a sleeper behind it for every month it has
   waited. A broker order is a single sealed pod with no queue at all: one month in
   flight, trembling in its straps, and then it is opened or it is void.

   Built here, on its own, so it can be worked on alone (viz/order.html) and dropped onto
   a shipping lane by the caller (viz/world3d.js), which owns the lane and the labels.

   Read it as a gauge:
     deck length   = qty ordered           · deck depth   = $M paid up front
     crates        = thousands undelivered · outlines     = the whole order, as placed
     flank band    = left / qty, exactly   · crate height = gen (N is twice the compute)
     lane position = the distance still to run · colour   = destination site
     chocks down   = not eligible yet (placed + 2)  · sleepers = months waited
     amber lamp    = eligible and starved  · orange = starved for months
     pod open, green halo = delivered      · red wireframe + returning chip = cancelled  */
import * as THREE from 'three';
import { STATUS } from './campus3d.js';

export const MIN_LEAD = 3;          // world.py: eligible from placed + MIN_LEAD - 1
export const QTY_MAX = 30;          // thousand GPUs: the hard per-order cap
export const K_PER_CRATE = 2.0;     // thousand GPUs in one crate
export const CRATES_MAX = QTY_MAX / K_PER_CRATE;         // 15 crates at the cap
export const CRATE_LEN = 0.95;      // world units along the lane
export const CRATE_W = 1.8;         // across it
export const CRATE_H = { H: 1.0, N: 1.7 };               // 1k H = 1 kH, 1k N = 2 kH
export const DECK_PER_M = 0.0011;   // deck depth per $M paid up front
export const DECK_MIN = 0.14;
export const DECK_W = CRATE_W + 0.5;
export const GATE_U = 0.18;         // share of the lane the pre-eligible lead covers
export const SLEEPER = 1.2;         // lane units per month waited, laid behind the tail
export const SLEEPERS_MAX = 8;
export const BROKER_REFUND = 0.8;   // world.py: the share of `paid` that comes back

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const crateSlots = qty => clamp(Math.ceil(qty / K_PER_CRATE - 1e-9), 1, CRATES_MAX);
export const deckLength = qty => crateSlots(qty) * CRATE_LEN;

// --- geometry built once and shared by every order ------------------------------------
const crateGeo = new THREE.BoxGeometry(1, 1, 1);
crateGeo.translate(0, 0.5, 0);                     // stands on the deck
const crateEdge = new THREE.EdgesGeometry(crateGeo);
const deckGeo = new THREE.BoxGeometry(1, 1, 1);
deckGeo.translate(0, -0.5, 0);                     // hangs below the lane, deck top at y = 0
const deckEdge = new THREE.EdgesGeometry(deckGeo);
const bandGeo = new THREE.BoxGeometry(1, 0.16, 0.1);
bandGeo.translate(0.5, 0, 0);                      // grows forward from the tail
const sleeperGeo = new THREE.BoxGeometry(0.2, 0.09, CRATE_W * 1.25);
const barGeo = new THREE.BoxGeometry(0.26, 0.26, CRATE_W + 1.1);
const chockGeo = new THREE.BoxGeometry(0.44, 0.44, 0.44);
const lampGeo = new THREE.BoxGeometry(0.1, 0.5, 0.5);
const haloGeo = new THREE.TorusGeometry(1, 0.1, 8, 72);
const chipGeo = new THREE.BoxGeometry(0.5, 0.5, 0.5);

const UP_Y = new THREE.Vector3(0, 1, 0);
const _p = new THREE.Vector3(), _t = new THREE.Vector3(), _s = new THREE.Vector3(),
      _u = new THREE.Vector3(), _m = new THREE.Matrix4();

export class Order {
  /* theme: the key's colours · color: the destination site's own · metal: v => v, so a
     paper key flattens every metalness at once · curve: the lane it rides, if the caller
     wants the object to place itself along it (it owns its own progress) */
  constructor({ theme, color, metal = v => v, curve = null }) {
    const T = this.theme = theme;
    this.color = color;
    this.curve = curve;
    this.u = 0;            // where it is along the lane, eased
    this.band = 0.001;     // the flank band's length, eased
    this.settled = false;  // the first update snaps, so a still frame is never mid-ease
    this.group = new THREE.Group();

    // the deck: the consignment itself, length = qty, depth = what it cost
    this.deck = new THREE.Mesh(deckGeo, new THREE.MeshStandardMaterial({
      color: T.pad, roughness: 0.9, metalness: metal(0.15) }));
    this.deck.castShadow = this.deck.receiveShadow = true;
    this.group.add(this.deck);
    this.deckEdge = new THREE.LineSegments(deckEdge, new THREE.LineBasicMaterial({
      color, transparent: true, opacity: 0.6 }));
    this.group.add(this.deckEdge);

    // --- vendor form: a train of crates, emptying from the head ---
    this.train = new THREE.Group();
    this.group.add(this.train);
    this.crateMat = new THREE.MeshStandardMaterial({
      color, emissive: color, emissiveIntensity: 0, roughness: 0.62, metalness: metal(0.28) });
    this.ghostMat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.3 });
    this.crates = [];
    this.ghosts = [];
    for (let i = 0; i < CRATES_MAX; i++) {
      const c = new THREE.Mesh(crateGeo, this.crateMat);
      c.castShadow = true; c.visible = false;
      this.train.add(c); this.crates.push(c);
      const g = new THREE.LineSegments(crateEdge, this.ghostMat);
      g.visible = false;
      this.train.add(g); this.ghosts.push(g);
    }

    // --- broker form: one sealed pod in its straps, which opens or voids ---
    this.pod = new THREE.Group();
    this.group.add(this.pod);
    this.podMat = new THREE.MeshStandardMaterial({
      color, emissive: color, emissiveIntensity: 0, roughness: 0.5, metalness: metal(0.3) });
    this.halves = [-1, 1].map(sign => {
      const h = new THREE.Mesh(crateGeo, this.podMat);
      h.userData.sign = sign;
      h.castShadow = true;
      this.pod.add(h);
      return h;
    });
    this.seal = new THREE.Mesh(crateGeo, new THREE.MeshStandardMaterial({
      color: STATUS.warning, emissive: STATUS.warning, emissiveIntensity: 0, roughness: 0.4 }));
    this.pod.add(this.seal);
    this.podGhost = new THREE.LineSegments(crateEdge, new THREE.LineBasicMaterial({
      color: STATUS.critical, transparent: true, opacity: 0.55 }));
    this.podGhost.visible = false;
    this.pod.add(this.podGhost);

    // the flank bands: left / qty, exactly, anchored at the tail
    this.bands = [-1, 1].map(sign => {
      const b = new THREE.Mesh(bandGeo, new THREE.MeshStandardMaterial({
        color, emissive: color, emissiveIntensity: 0, roughness: 0.35 }));
      b.position.z = sign * (DECK_W / 2 + 0.06);        // on the deck's flank, not inside it
      this.group.add(b);
      return b;
    });

    // the hold: a bar across the head and chocks under the deck, until it is eligible
    this.hold = new THREE.Group();
    this.group.add(this.hold);
    const holdMat = new THREE.MeshStandardMaterial({
      color: T.steel, emissive: STATUS.warning, emissiveIntensity: 0.45 * T.emissive,
      roughness: 0.55, metalness: metal(0.6) });
    this.bar = new THREE.Mesh(barGeo, holdMat);
    this.hold.add(this.bar);
    this.chocks = [0, 1].map(() => {
      const c = new THREE.Mesh(chockGeo, holdMat);
      this.hold.add(c);
      return c;
    });

    // the head lamp: ineligible · starved · draining · resolved, in one light
    this.lamp = new THREE.Mesh(lampGeo, new THREE.MeshStandardMaterial({
      color: T.tick, emissive: T.tick, emissiveIntensity: 0, roughness: 0.3 }));
    this.group.add(this.lamp);

    // sleepers: one laid on the lane for every month this order has existed
    this.sleepers = [];
    for (let i = 0; i < SLEEPERS_MAX; i++) {
      const s = new THREE.Mesh(sleeperGeo, new THREE.MeshStandardMaterial({
        color: T.steel, emissive: 0x000000, emissiveIntensity: 0, roughness: 0.7,
        metalness: metal(0.3) }));
      s.visible = false;
      this.group.add(s);
      this.sleepers.push(s);
    }

    // the outcome, once there is one: a halo on the lane, and the refund flying home
    this.halo = new THREE.Mesh(haloGeo, new THREE.MeshBasicMaterial({
      color: STATUS.good, transparent: true, opacity: 0 }));
    this.halo.rotation.x = Math.PI / 2;
    this.halo.visible = false;
    this.group.add(this.halo);
    this.chip = new THREE.Mesh(chipGeo, new THREE.MeshStandardMaterial({
      color: STATUS.warning, emissive: STATUS.warning, emissiveIntensity: 0.6 * T.emissive,
      transparent: true, opacity: 0, roughness: 0.4 }));
    this.chip.visible = false;
    this.group.add(this.chip);
  }

  /* put the group on a curve at u, its +X along the tangent. upHint is the surface
     normal the rider should stand on — world Y on a flat bench, the sphere normal on
     the globe. */
  rideOn(curve, u, upHint = UP_Y) {
    curve.getPointAt(clamp(u, 0, 1), _p);
    curve.getTangentAt(clamp(u, 0, 1), _t).normalize();
    _s.copy(_t).cross(upHint).normalize();
    _u.copy(_s).cross(_t).normalize();
    _m.makeBasis(_t, _u, _s);
    this.group.position.copy(_p);
    this.group.quaternion.setFromRotationMatrix(_m);
  }

  /* d: the order record, plus the clock and what the month did to it
        src 'vendor' | 'A' | 'B'   gen 'H' | 'N'
        qty, left (thousands of GPUs)   placed, month (months, month may be fractional)
        paid ($M)                       site is the caller's business: it picks `color`
        drain (thousands delivered in the latest month, optional — from the diff of
          `left` between two frames; without it, any order past its first fill counts
          as draining)
        delivered, cancelled (optional: the broker resolution, from history[k].broker) */
  update(d, time) {
    const T = this.theme;
    // every ease snaps on the first update, so a still frame is never caught halfway
    const ez = k => (this.settled ? k : 1);
    const { src = 'vendor', gen = 'H', qty = 1, left = qty, placed = 0, paid = 0,
            drain = null } = d;
    const month = d.month ?? placed;
    const broker = src !== 'vendor';
    const cancelled = !!d.cancelled;
    const delivered = d.delivered ?? (!cancelled && left <= 1e-6);
    const done = cancelled || delivered;

    // --- what kind of waiting this is
    const age = Math.max(0, month - placed);
    const held = !broker && !done && month < placed + MIN_LEAD - 1;
    const waited = Math.max(0, Math.floor(age + 1e-6) - (broker ? 0 : MIN_LEAD - 1));
    const filled = qty > 1e-9 ? clamp(1 - left / qty, 0, 1) : 1;
    const pending = broker && !done;        // one month in flight, and then it is decided
    const draining = !done && !held && !broker && (drain === null ? filled > 1e-6 : drain > 1e-6);
    const starved = !done && !held && !broker && !draining;

    // --- the distance still to run. a vendor order's progress *is* its drain: the lead
    // months only carry it as far as the gate, and then it moves when allocation arrives.
    let target;
    if (done) target = 1;
    else if (broker) target = clamp(month - placed, 0, 1);
    else target = GATE_U * clamp((month - placed) / (MIN_LEAD - 1), 0, 1) + (1 - GATE_U) * filled;
    this.u += (target - this.u) * ez(0.08);
    if (this.curve) this.rideOn(this.curve, this.u);

    // --- the consignment: length is the order, depth is the cheque
    const n = crateSlots(qty);
    const L = n * CRATE_LEN;
    const H = CRATE_H[gen] || CRATE_H.H;
    const depth = DECK_MIN + paid * DECK_PER_M;
    this.deck.scale.set(L, depth, DECK_W);
    this.deck.position.x = -L / 2;
    this.deckEdge.scale.copy(this.deck.scale);
    this.deckEdge.position.x = -L / 2;

    // crates stand in the rear slots: the head of the train empties first
    const share = qty / n;
    this.train.visible = !broker;
    this.pod.visible = broker;
    if (!broker) {
      for (let i = 0; i < CRATES_MAX; i++) {
        const used = i < n;
        const x = -(i + 0.5) * CRATE_LEN;
        const solid = used && (i + 0.5) * share > qty - left + 1e-9;
        this.crates[i].visible = solid;
        this.ghosts[i].visible = used;
        if (used) {
          this.crates[i].position.x = this.ghosts[i].position.x = x;
          this.crates[i].scale.set(CRATE_LEN * 0.84, H, CRATE_W);
          this.ghosts[i].scale.set(CRATE_LEN * 0.84, H, CRATE_W);
        }
      }
    } else {
      // one pod, split along the lane, hinging open on delivery
      const open = delivered ? 0.9 + 0.12 * Math.sin(time * 1.1) : 0;
      for (const h of this.halves) {
        h.scale.set(L * 0.94, H * 1.25, CRATE_W / 2 - 0.04);
        h.position.set(-L / 2, open * H * 0.12, h.userData.sign * (CRATE_W / 4 + open * 0.75));
        h.rotation.x = h.userData.sign * open * 0.45;
        h.visible = !cancelled;
      }
      this.seal.visible = !cancelled && !delivered;   // the seal is broken on delivery
      this.seal.scale.set(0.2, H * 1.34, CRATE_W + 0.12);
      this.seal.position.x = -L / 2;
      this.podGhost.visible = cancelled;
      this.podGhost.scale.set(L * 0.94, H * 1.25, CRATE_W);
      this.podGhost.position.x = -L / 2;
    }

    // --- the mood of the thing, and the one lamp that carries it
    const mood = cancelled ? STATUS.critical
      : delivered ? STATUS.good
      : held ? T.steel
      : pending ? STATUS.warning
      : starved ? (waited >= 3 ? STATUS.serious : STATUS.warning)
      : this.color;
    const pulse = pending ? 0.5 + 0.5 * Math.abs(Math.sin(time * 5.5))            // about to be decided
      : draining ? 0.55 + 0.16 * Math.sin(time * 1.7)
      : starved ? 0.3 + 0.1 * Math.sin(time * 0.7)
      : done ? 0.8 + 0.12 * Math.sin(time * 1.1)
      : 0.08;
    const moodC = new THREE.Color(mood);
    this.lamp.material.color.lerp(moodC, ez(0.14));
    this.lamp.material.emissive.lerp(moodC, ez(0.14));
    this.lamp.material.emissiveIntensity += (pulse * 2.0 * T.emissive - this.lamp.material.emissiveIntensity) * ez(0.15);
    this.lamp.visible = !cancelled;
    this.lamp.position.set(0.12, H * 0.55, 0);
    this.lamp.scale.setScalar(1 + (pending ? 0.25 * pulse : 0));

    // live hardware glows a little; held, starved and void hardware is matte
    const glow = (draining ? 0.22 : delivered ? 0.5 : 0) * T.emissive;
    this.crateMat.emissiveIntensity += (glow - this.crateMat.emissiveIntensity) * ez(0.12);
    this.podMat.emissiveIntensity += (glow - this.podMat.emissiveIntensity) * ez(0.12);
    this.podMat.emissive.lerp(new THREE.Color(delivered ? STATUS.good : this.color), ez(0.1));
    this.seal.material.color.lerp(moodC, ez(0.14));
    this.seal.material.emissive.lerp(moodC, ez(0.14));
    this.seal.material.emissiveIntensity += (pulse * 1.6 * T.emissive - this.seal.material.emissiveIntensity) * ez(0.15);

    // the flank band: the exact share still undelivered, read off the deck
    const want = Math.max(0.001, (left / Math.max(qty, 1e-9)) * L);
    this.band += (want - this.band) * ez(0.14);
    for (const b of this.bands) {
      b.visible = left > 1e-6 && !done;
      b.position.x = -L;
      b.position.y = -depth * 0.5;
      b.scale.x = this.band;
      b.material.color.lerp(moodC, ez(0.14));
      b.material.emissive.lerp(moodC, ez(0.14));
      b.material.emissiveIntensity += ((0.3 + pulse * 0.9) * T.emissive - b.material.emissiveIntensity) * ez(0.15);
    }

    // the hold: down across the head and under the wheels until the queue can touch it
    this.hold.visible = held;
    this.bar.position.set(0.3, H * 0.75, 0);
    this.bar.rotation.z = 0;
    this.chocks[0].position.set(-0.45, -depth * 0.5, CRATE_W / 2 + 0.3);
    this.chocks[1].position.set(-L + 0.45, -depth * 0.5, -(CRATE_W / 2 + 0.3));

    // sleepers behind the tail: the lead months in steel, every month waited in amber
    const months = Math.min(SLEEPERS_MAX, Math.floor(age + 1e-6));
    for (let i = 0; i < SLEEPERS_MAX; i++) {
      const on = i < months && !done;
      this.sleepers[i].visible = on;
      if (!on) continue;
      const lead = !broker && i < MIN_LEAD - 1;
      const c = new THREE.Color(lead ? T.steel : waited >= 3 ? STATUS.serious : STATUS.warning);
      this.sleepers[i].position.set(-L - (i + 1) * SLEEPER, -depth * 0.5, 0);
      this.sleepers[i].material.color.lerp(c, ez(0.12));
      this.sleepers[i].material.emissive.lerp(lead ? new THREE.Color(0x000000) : c, ez(0.12));
      this.sleepers[i].material.emissiveIntensity += ((lead ? 0 : 0.35) * T.emissive - this.sleepers[i].material.emissiveIntensity) * ez(0.12);
    }

    // the outcome: a halo on the lane, and the 80 % refund riding back up it
    this.halo.visible = done;
    if (done) {
      this.halo.material.color.lerp(new THREE.Color(cancelled ? STATUS.critical : STATUS.good), ez(0.12));
      this.halo.material.opacity = 0.3 + 0.25 * Math.abs(Math.sin(time * 1.1));
      this.halo.position.set(-L / 2, 0.06, 0);
      this.halo.scale.setScalar(Math.max(L * 0.78, CRATE_W * 1.25));
    }
    this.chip.visible = cancelled;
    if (cancelled) {
      const ph = (time * 0.33) % 1;
      const s = Math.cbrt(Math.max(0.2, BROKER_REFUND * paid * 0.02));
      this.chip.scale.setScalar(s);
      this.chip.position.set(-L - 1.2 - ph * 11, H * 0.3, 0);
      this.chip.rotation.set(time * 0.7, time * 1.1, 0);
      this.chip.material.opacity = 0.9 * Math.sin(Math.PI * ph);
    }
    this.settled = true;
  }
}
