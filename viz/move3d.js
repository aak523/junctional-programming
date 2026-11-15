/* A fleet move: hardware in transit between two sites, as an object.

   A crated consignment on a flatbed, under way on a site-to-site arc. The hardware left
   `owned[frm]` the instant the command ran, so for this one month it is powered nowhere:
   the rig is the only matte, unlit thing in a scene of living sites. Its crates keep a
   bright hairline edge — in-transit GPUs are still marked at settlement, so the asset is
   on the books, it just earns nothing. It lands next month.

   The two things the move costs sit at the ends of the arc: an empty outline of a footprint
   on the origin pad, exactly the size of what left (red when the origin is now short of
   its own inference demand — each site serves only its own 50/30/20 share, which is the
   only reason moving ever pays), and an amber ghost on the destination pad that fills in
   as the month runs out.

   Built here, on its own, so it can be worked on alone (viz/move.html) and dropped onto
   the sphere by the caller (viz/world3d.js), which hands it a greatArc and owns the
   labels. `scaffold: false` drops the bench's arc and pads; the end furniture stays,
   anchored to the curve's endpoints.

   Read it as a gauge:
     stack height    = thousands of GPUs moving    · crate seams = kH (gen N splits twice)
     portal crossbar = MOVE_CAP, 5k/month          · band under it = the rest of the month's moves
     gap to the bar  = cap still free this month
     lit rail ahead  = distance left to run        · dim rail behind = month elapsed
     nose / tail cap = destination / origin colour · ticks = tenths of the month
     origin footprint= the hole left behind, red if the site is now short
     destination ghost = what lands next month, brightening as it arrives            */
import * as THREE from 'three';
import { STATUS } from './campus3d.js';

export const CAP = 5.0;                      // MOVE_CAP: k GPUs per month, all moves at once
export const COST = 0.5;                     // MOVE_COST: $M per thousand moved
export const COMPUTE = { H: 1.0, N: 2.0 };   // kH per thousand, from world.py
export const STACK = 1.15;                   // world units of stack height per thousand GPUs
export const BED_L = 5.4;                    // the flatbed, along travel
export const BED_W = 3.4;                    // and across it
export const HULL_H = 0.6;                   // hull depth below the deck
export const PAD_R = 4.6;                    // end pad radius, for callers that space things out
export const SPAN = 28.0;                    // bench arc: chord between the pads
export const LIFT = 5.5;                     // and its apex above them
export const LAYERS = 12;                    // crate pool: gen N at the cap needs 10

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const stackHeight = qty => qty * STACK;

// --- geometry built once and shared by every move -------------------------------------
const upBox = new THREE.BoxGeometry(1, 1, 1);      // grows up from its base
upBox.translate(0, 0.5, 0);
const upEdges = new THREE.EdgesGeometry(upBox);
const downBox = new THREE.BoxGeometry(1, 1, 1);    // hangs down from its top
downBox.translate(0, -0.5, 0);
const hullGeo = new THREE.BoxGeometry(BED_L, HULL_H, BED_W);
hullGeo.translate(0, -HULL_H / 2, 0);              // deck is y = 0 in rig space
const capGeo = new THREE.BoxGeometry(0.3, HULL_H + 0.45, BED_W * 0.98);
capGeo.translate(0, -HULL_H / 2 + 0.1, 0);
const skidGeo = new THREE.BoxGeometry(BED_L * 0.5, 0.26, 0.4);
skidGeo.translate(0, -HULL_H - 0.13, 0);
// the raked bow, so the rig reads as a vehicle with a front
const noseGeo = (() => {
  const s = new THREE.Shape();
  s.moveTo(0, 0); s.lineTo(1.15, 0); s.lineTo(0, -HULL_H); s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: BED_W, bevelEnabled: false, curveSegments: 1 });
  g.translate(0, 0, -BED_W / 2);
  return g;
})();
const postGeo = new THREE.BoxGeometry(0.22, 1, 0.22);
postGeo.translate(0, 0.5, 0);

// scratch, so the per-frame maths allocates nothing
const _fwd = new THREE.Vector3(), _right = new THREE.Vector3(), _up = new THREE.Vector3();
const _UP = new THREE.Vector3(0, 1, 0), _m = new THREE.Matrix4(), _c = new THREE.Color();

const quadArc = (span, lift) => new THREE.QuadraticBezierCurve3(
  new THREE.Vector3(-span / 2, 0, 0), new THREE.Vector3(0, lift * 2, 0), new THREE.Vector3(span / 2, 0, 0));

export class Move {
  /* theme: the key's colours · fromColor / toColor: the two sites' own (the origin is not
     in the record — the globe parses it from the action log) · metal: v => v, so a paper
     key can flatten every metalness · curve: the arc it rides, default a bench arc ·
     scaffold: that arc and its two pads, which the globe already owns */
  constructor({ theme, fromColor, toColor, metal = v => v, curve = null, scaffold = true }) {
    const T = this.theme = theme;
    this.from = new THREE.Color(fromColor);
    this.to = new THREE.Color(toColor);
    this.curve = curve || quadArc(SPAN, LIFT);
    this.qty = 0; this.prog = 0; this.used = 0; this.left = 0; this.short = 0;
    this.group = new THREE.Group();

    const A = this.curve.getPointAt(0), B = this.curve.getPointAt(1);

    // ---- the scaffolding: the arc and a pad at each end ----
    this.scaffold = new THREE.Group();
    this.scaffold.visible = scaffold;
    this.group.add(this.scaffold);

    // the rail, as two strips over the same 65 points: a draw range each, so the split
    // between spent and remaining is a range change and never a rebuild
    const pts = [];
    for (let i = 0; i <= 64; i++) pts.push(this.curve.getPointAt(i / 64));
    const rail = (c, op) => {
      const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({ color: c, transparent: true, opacity: op }));
      this.scaffold.add(l);
      return l;
    };
    this.tube = new THREE.Mesh(new THREE.TubeGeometry(this.curve, 96, 0.12, 6, false),
      new THREE.MeshBasicMaterial({ color: T.steel, transparent: true, opacity: T.lane }));
    this.scaffold.add(this.tube);
    this.railDone = rail(fromColor, 0.14);   // the part of the month already spent
    this.railLeft = rail(toColor, 0.9);      // and the distance still to run

    // graduations: tenths of the month. The ones still ahead stay lit, the ones already
    // passed go out, so the remaining run is readable off the scale as well as the rail.
    this.ticks = [];
    for (let i = 1; i < 10; i++) {
      const g = new THREE.Mesh(downBox, new THREE.MeshBasicMaterial({
        color: T.tick, transparent: true, opacity: 0.3 }));
      g.scale.set(0.1, i === 5 ? 1.6 : 0.8, 0.1);
      g.position.copy(this.curve.getPointAt(i / 10));
      g.userData.t = i / 10;
      this.scaffold.add(g);
      this.ticks.push(g);
    }

    const padGeo = new THREE.CylinderGeometry(PAD_R, PAD_R, 0.4, 56);
    padGeo.translate(0, 0.2, 0);
    const ringGeo = new THREE.RingGeometry(PAD_R * 0.96, PAD_R, 64);
    this.pads = [[A, fromColor], [B, toColor]].map(([p, c]) => {
      const m = new THREE.Mesh(padGeo, new THREE.MeshStandardMaterial({
        color: T.pad, emissive: c, emissiveIntensity: 0.1 * T.emissive, roughness: 0.92,
        metalness: metal(0.1) }));
      m.position.copy(p);
      m.receiveShadow = true;
      this.scaffold.add(m);
      const r = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({
        color: c, transparent: true, opacity: 0.6, side: THREE.DoubleSide }));
      r.rotation.x = -Math.PI / 2;
      r.position.copy(p).y += 0.42;
      this.scaffold.add(r);
      return m;
    });

    // ---- the end furniture: the hole behind, the arrival ahead ----
    // Anchored to the curve's endpoints, so it survives scaffold: false.
    const block = (geo, mat, p, z, Kind = THREE.Mesh) => {
      const m = new Kind(geo, mat);
      m.position.copy(p).z += z;
      m.position.y += 0.4;
      this.group.add(m);
      return m;
    };
    // the hole: an empty footprint of exactly what left, on the origin pad
    this.hole = block(upEdges, new THREE.LineBasicMaterial({
      color: T.steel, transparent: true, opacity: 0.6 }), A, 2.9, THREE.LineSegments);
    // what the origin still has of that generation — still at a site, so still lit
    this.rest = block(upBox, new THREE.MeshStandardMaterial({
      color: T.shed, emissive: fromColor, emissiveIntensity: 0.22 * T.emissive,
      roughness: 0.7, metalness: metal(0.2) }), A, -2.9);
    this.rest.castShadow = true;
    this.restEdge = block(upEdges, new THREE.LineBasicMaterial({
      color: T.tick, transparent: true, opacity: 0.5 }), A, -2.9, THREE.LineSegments);
    // and the arrival: contracted but not live, so amber, filling as the month runs out
    this.ghost = block(upEdges, new THREE.LineBasicMaterial({
      color: STATUS.warning, transparent: true, opacity: 0.3 }), B, 0, THREE.LineSegments);

    // ---- the rig: the thing that moves ----
    this.rig = new THREE.Group();
    this.group.add(this.rig);
    const hullMat = new THREE.MeshStandardMaterial({
      color: T.steel, roughness: 0.68, metalness: metal(0.45) });  // matte: it is powered nowhere
    this.hull = new THREE.Mesh(hullGeo, hullMat);
    this.hull.castShadow = true;
    this.rig.add(this.hull);
    const nose = new THREE.Mesh(noseGeo, hullMat);
    nose.position.x = BED_L / 2;
    nose.castShadow = true;
    this.rig.add(nose);
    for (const s of [-1, 1]) {
      const k = new THREE.Mesh(skidGeo, new THREE.MeshStandardMaterial({
        color: T.towerOff, roughness: 0.8, metalness: metal(0.3) }));
      k.position.z = s * BED_W * 0.3;
      this.rig.add(k);
    }
    // which way it is going, readable off the rig alone: tail origin, nose destination
    const endCap = (c, x) => {
      const m = new THREE.Mesh(capGeo, new THREE.MeshStandardMaterial({
        color: c, roughness: 0.55, metalness: metal(0.3) }));
      m.position.x = x;
      this.rig.add(m);
      return m;
    };
    endCap(fromColor, -BED_L / 2 - 0.14);
    endCap(toColor, BED_L / 2 + 1.21);

    // the crates: one layer per kH, so gen N divides the same height twice as finely
    const crateMat = new THREE.MeshStandardMaterial({
      color: T.shed, roughness: 0.82, metalness: metal(0.12) });
    const seamMat = new THREE.LineBasicMaterial({ color: T.tick, transparent: true, opacity: 0.6 });
    this.crates = []; this.seams = [];
    for (let i = 0; i < LAYERS; i++) {
      const c = new THREE.Mesh(upBox, crateMat);
      c.castShadow = true; c.visible = false;
      this.rig.add(c); this.crates.push(c);
      const s = new THREE.LineSegments(upEdges, seamMat);
      s.visible = false;
      this.rig.add(s); this.seams.push(s);
    }

    // gen N, in the campus's own vocabulary: plant on the roof of the load
    this.plant = [];
    for (let i = 0; i < 3; i++) {
      const m = new THREE.Mesh(upBox, new THREE.MeshStandardMaterial({
        color: T.roof, roughness: 0.5, metalness: metal(0.35) }));
      m.castShadow = true; m.visible = false;
      this.rig.add(m); this.plant.push(m);
    }

    // the loading gauge: a portal the consignment travels under, crossbar at MOVE_CAP
    const barY = CAP * STACK;
    const steel = new THREE.MeshStandardMaterial({
      color: T.trim, roughness: 0.5, metalness: metal(0.2) });
    for (const s of [-1, 1]) {
      const p = new THREE.Mesh(postGeo, steel);
      p.scale.y = barY;
      p.position.z = s * (BED_W / 2 + 0.55);
      this.rig.add(p);
    }
    const barGeo = new THREE.BoxGeometry(0.42, 0.26, BED_W + 2.1);
    barGeo.translate(0, 0.11, 0);                 // its underside is the ceiling
    this.bar = new THREE.Mesh(barGeo, steel);
    this.bar.position.y = barY;
    this.rig.add(this.bar);
    // and the share of the cap the month's other moves already took, hanging off it
    this.taken = new THREE.Mesh(downBox, new THREE.MeshBasicMaterial({
      color: T.trim, transparent: true, opacity: 0.13 }));
    this.taken.visible = false;
    this.rig.add(this.taken);
    this.takenEdge = new THREE.LineSegments(new THREE.EdgesGeometry(downBox),
      new THREE.LineBasicMaterial({ color: T.trim, transparent: true, opacity: 0.4 }));
    this.takenEdge.visible = false;
    this.rig.add(this.takenEdge);
  }

  /* d: gen 'H' | 'N' · qty (thousands of GPUs in this move)
        prog 0..1 (how far through the one month in flight)
        movedNow (thousands moved this month across all moves, >= qty)
        fromLeft (thousands of that gen still at the origin)
        shortfall (kH of origin demand it can no longer cover — derived, see move.js) */
  update(d, time) {
    const T = this.theme;
    const gen = d.gen === 'N' ? 'N' : 'H';
    const tgt = clamp(d.prog ?? 0, 0, 1);

    this.qty += (Math.max(0, d.qty || 0) - this.qty) * 0.14;
    this.used += (clamp((d.movedNow ?? d.qty ?? 0) - (d.qty || 0), 0, CAP) - this.used) * 0.14;
    this.left += (Math.max(0, d.fromLeft || 0) - this.left) * 0.14;
    this.short += (Math.max(0, d.shortfall || 0) - this.short) * 0.14;
    // a scrub or a replay restart jumps the arc; anything smaller eases
    this.prog = Math.abs(tgt - this.prog) > 0.4 ? tgt : this.prog + (tgt - this.prog) * 0.25;
    const p = this.prog;

    // --- the consignment: height is thousands, seams are kH
    const H = Math.max(0.02, stackHeight(this.qty));
    const units = clamp(Math.ceil(this.qty * COMPUTE[gen] - 1e-6), 1, LAYERS);
    const lh = H / units;
    for (let i = 0; i < LAYERS; i++) {
      const on = i < units && this.qty > 0.01;
      this.crates[i].visible = on; this.seams[i].visible = on;
      if (!on) continue;
      for (const m of [this.crates[i], this.seams[i]]) {
        m.scale.set(BED_L * 0.9, lh * 0.9, BED_W * 0.84);
        m.position.y = i * lh + lh * 0.05;
      }
    }

    for (let i = 0; i < this.plant.length; i++) {
      const on = gen === 'N' && this.qty > 0.01;
      this.plant[i].visible = on;
      if (!on) continue;
      this.plant[i].scale.set(0.9, 0.42, BED_W * 0.5);
      this.plant[i].position.set((i - 1) * 1.5, H + lh * 0.05, 0);
    }

    // --- the cap, as headroom under the crossbar
    this.taken.visible = this.takenEdge.visible = this.used > 0.02;
    for (const m of [this.taken, this.takenEdge]) {
      m.scale.set(BED_L * 0.7, Math.max(0.02, stackHeight(this.used)), BED_W * 0.62);
      m.position.y = this.bar.position.y;
    }

    // --- riding the arc: forward is the tangent, up stays with the surface
    const pos = this.curve.getPointAt(p);
    this.curve.getTangentAt(p, _fwd).normalize();
    _fwd.y *= 0.34; _fwd.normalize();            // climbs and descends without tipping the load
    _right.crossVectors(_fwd, _UP).normalize();
    _up.crossVectors(_right, _fwd).normalize();
    this.rig.position.copy(pos).addScaledVector(_up, HULL_H + 0.3 + Math.sin(time * 1.5) * 0.1);
    this.rig.quaternion.setFromRotationMatrix(_m.makeBasis(_fwd, _up, _right));
    this.rig.rotateX(Math.sin(time * 0.9) * 0.018);   // the sway of something under way

    // --- the rail: dim behind, lit ahead, so the distance left is the bright part
    const k = Math.round(p * 64);
    this.railDone.geometry.setDrawRange(0, k + 1);
    this.railLeft.geometry.setDrawRange(k, 65 - k);
    this.railDone.visible = k > 0;
    this.railLeft.visible = k < 64;
    for (const g of this.ticks) g.material.opacity = g.userData.t > p ? 0.6 : 0.08;

    // --- the hole left at the origin, and what is still standing beside it
    const short = this.short > 0.02;
    const fw = BED_L * 0.5, fd = BED_W * 0.5;     // the end blocks share the height scale only
    this.hole.scale.set(fw, H, fd);
    this.hole.material.color.lerp(_c.setHex(short ? STATUS.critical : T.steel), 0.1);
    this.hole.material.opacity = short ? 0.5 + 0.28 * Math.abs(Math.sin(time * 2.2)) : 0.4;
    const rh = Math.max(0.02, stackHeight(this.left));
    for (const m of [this.rest, this.restEdge]) m.scale.set(fw, rh, fd);
    this.rest.visible = this.restEdge.visible = this.left > 0.01;
    this.rest.material.emissiveIntensity = (0.18 + 0.07 * Math.sin(time * 1.3)) * T.emissive;

    // --- and the arrival, filling in as the month runs out
    this.ghost.scale.set(fw, H * (0.25 + 0.75 * p), fd);
    this.ghost.material.opacity = 0.32 + 0.5 * p;
    this.ghost.visible = this.qty > 0.01;
  }
}
