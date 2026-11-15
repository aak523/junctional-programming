/* The campus: one site's data centre, as an object.

   It is a single long shed with a pitched roof, standing on its apron — the shape these
   buildings actually are. It grows along its length as the site's fleet grows, its vent
   band lights along the part of that fleet that has power, and rooftop plant appears as
   gen N moves in. The two site gauges that are not the building itself (spot fills and
   the month's demand bar) hang off the apron and can be left off entirely with
   `gauges: false`.

   Built here, on its own, so it can be worked on alone (viz/campus.html) and dropped onto
   the sphere by the caller (viz/world3d.js), which positions it and owns its labels.

   Read it as a gauge:
     building length = owned compute        · vent band = the part of it under power
     rooftop plant   = gen N on site        · pillars    = spot fills this month
     apron bar       = served | training | unserved, with a tick at demand

   `reserved`, `option`, `mw` and `mwPending` are still accepted and still shape the bar
   through capacity; they simply have no object of their own on the campus any more.    */
import * as THREE from 'three';

export const SHED_W = 7.0;        // across the building
export const WALL_H = 3.0;        // eaves height above the deck
export const ROOF_RISE = 2.0;     // ridge above the eaves
export const EAVE = 0.45;         // roof overhang
export const DECK = 0.5;          // apron thickness: the building's floor
export const LEN_BASE = 9.0;      // length at an empty site
export const LEN_PER_KH = 0.7;    // and how it grows
export const LEN_MAX = 26.0;
export const PAD_R = LEN_MAX / 2; // the footprint a site needs, for callers that space things out
export const KH = 0.34;           // world units per kH on the apron bar
export const STATUS = { good: 0x0ca30c, warning: 0xfab219, serious: 0xec835a, critical: 0xd03b3b };

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const shedLength = kh => clamp(LEN_BASE + kh * LEN_PER_KH, LEN_BASE, LEN_MAX);

// --- geometry built once and shared by every campus -----------------------------------
// The shell is the walls and both gable ends in one extrusion: a pentagon profile pulled
// along a unit length, so the length is a scale and never a rebuild.
const shellGeo = (() => {
  const w = SHED_W / 2;
  const s = new THREE.Shape();
  s.moveTo(-w, 0); s.lineTo(w, 0); s.lineTo(w, WALL_H); s.lineTo(0, WALL_H + ROOF_RISE); s.lineTo(-w, WALL_H);
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: 1, bevelEnabled: false, curveSegments: 1 });
  g.translate(0, 0, -0.5);          // centre the extrusion
  g.rotateY(Math.PI / 2);           // and lay its length along x
  return g;
})();

const HW = SHED_W / 2 + EAVE;                                   // half width at the eaves
const SLOPE = Math.hypot(HW, ROOF_RISE);                        // length of one roof plane
const PITCH = Math.atan2(ROOF_RISE, HW);
const roofGeo = new THREE.BoxGeometry(1, 0.26, SLOPE);
const ridgeGeo = new THREE.BoxGeometry(1, 0.22, 0.5);
const aprGeo = new THREE.BoxGeometry(1, DECK, 1);
aprGeo.translate(0, DECK / 2, 0);
const doorGeo = new THREE.BoxGeometry(1.7, 2.1, 0.12);
doorGeo.translate(0, 1.05, 0);
const ventGeo = new THREE.BoxGeometry(1, 0.42, 0.12);
ventGeo.translate(0.5, 0, 0);                                   // grows from its left end
const plantGeo = new THREE.BoxGeometry(1.5, 0.75, 1.9);
plantGeo.translate(0, 0.375, 0);
const towerGeo = new THREE.BoxGeometry(1, 1, 1);
towerGeo.translate(0, 0.5, 0);

export class Campus {
  /* theme: the key's colours · color: the site's own · metal: v => v, so a paper key can
     flatten every metalness at once · gauges: the site furniture around the building */
  constructor({ theme, color, metal = v => v, gauges = true }) {
    const T = this.theme = theme;
    this.color = color;
    this.len = LEN_BASE;
    this.group = new THREE.Group();
    const add = m => { this.group.add(m); return m; };

    // apron: the slab the shed stands on, and the site's hit target
    this.pad = add(new THREE.Mesh(aprGeo, new THREE.MeshStandardMaterial({
      color: T.pad, roughness: 0.92, metalness: metal(0.1) })));
    this.pad.receiveShadow = true;

    // the shed
    this.shell = add(new THREE.Mesh(shellGeo, new THREE.MeshStandardMaterial({
      color: T.shed, roughness: 0.78, metalness: metal(0.18) })));
    this.shell.position.y = DECK;
    this.shell.castShadow = true; this.shell.receiveShadow = true;

    const roofMat = new THREE.MeshStandardMaterial({ color: T.roof, roughness: 0.62, metalness: metal(0.3) });
    this.roofs = [-1, 1].map(sign => {
      const r = add(new THREE.Mesh(roofGeo, roofMat));
      r.position.set(0, DECK + WALL_H + ROOF_RISE / 2, sign * HW / 2);
      r.rotation.x = sign * PITCH;
      r.castShadow = true;
      return r;
    });
    this.ridge = add(new THREE.Mesh(ridgeGeo, roofMat));
    this.ridge.position.y = DECK + WALL_H + ROOF_RISE + 0.02;

    // loading bays along the front
    this.doors = [];
    {
      const mat = new THREE.MeshStandardMaterial({ color: T.roof, roughness: 0.5, metalness: metal(0.4) });
      for (let i = 0; i < 9; i++) {
        const d = add(new THREE.Mesh(doorGeo, mat));
        d.position.set(0, DECK, SHED_W / 2 + 0.05);
        d.visible = false;
        this.doors.push(d);
      }
    }

    // the vent band: how much of the shed is actually under power
    this.vents = [-1, 1].map(sign => {
      const v = add(new THREE.Mesh(ventGeo, new THREE.MeshStandardMaterial({
        color: T.trim, emissive: 0x000000, roughness: 0.4 })));
      v.position.set(0, DECK + WALL_H - 0.5, sign * (SHED_W / 2 + 0.03));
      return v;
    });

    // rooftop plant: gen N moving in
    this.plant = [];
    {
      const mat = new THREE.MeshStandardMaterial({ color: T.trim, roughness: 0.45, metalness: metal(0.35) });
      for (let i = 0; i < 9; i++) {
        const p = add(new THREE.Mesh(plantGeo, mat));
        p.position.y = DECK + WALL_H + ROOF_RISE - 0.1;
        p.visible = false;
        this.plant.push(p);
      }
    }

    // ---- site furniture: everything that is not the building ----
    this.gauges = gauges;
    this.extras = new THREE.Group();
    this.extras.visible = gauges;
    this.group.add(this.extras);

    this.spots = [];
    for (let i = 0; i < 6; i++) {
      const p = new THREE.Mesh(
        new THREE.CylinderGeometry(0.14, 0.14, 6, 8, 1, true),
        new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 1.1 * T.emissive,
          transparent: true, opacity: 0.5, side: THREE.DoubleSide }));
      p.position.set(-(LEN_BASE / 2 + 2.2), DECK + 3, -(SHED_W / 2 + 1.4) + i * 1.1);
      p.visible = false;
      this.extras.add(p);
      this.spots.push(p);
    }

    // the month, on the apron: served | training | unserved, tick at demand
    this.bar = new THREE.Group();
    this.extras.add(this.bar);
    const seg = (c, op, emi) => {
      const g = new THREE.BoxGeometry(1, 0.3, 2.2);
      g.translate(0.5, 0, 0);
      const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({
        color: c, emissive: c, emissiveIntensity: emi * T.emissive, transparent: op < 1, opacity: op, roughness: 0.5 }));
      m.visible = false;
      this.bar.add(m);
      return m;
    };
    this.segServed = seg(color, 1, 0.75);
    this.segTrain = seg(color, 0.42, 0.3);
    this.segUnserved = seg(STATUS.critical, 1, 1.0);
    this.tick = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.9, 2.9),
      new THREE.MeshStandardMaterial({ color: T.tick, emissive: T.tick, emissiveIntensity: 0.9 * T.emissive }));
    this.bar.add(this.tick);

    // event ring pool (broker delivered / cancelled)
    this.rings = [];
    for (let i = 0; i < 3; i++) {
      const r = new THREE.Mesh(new THREE.TorusGeometry(1, 0.2, 8, 64),
        new THREE.MeshBasicMaterial({ color: STATUS.good, transparent: true, opacity: 0 }));
      r.rotation.x = Math.PI / 2; r.position.y = DECK + 0.3; r.visible = false;
      this.group.add(r);
      this.rings.push(r);
    }
  }

  burst(color) {
    const r = this.rings.find(x => !x.visible) || this.rings[0];
    r.material.color.setHex(color);
    r.visible = true; r.userData.t = 0;
  }

  /* d: ownedH, ownedN, poweredH, poweredN (thousands of GPUs)
        reserved, option, spot, served, training, unserved, demand (kH)
        mw, mwPending (megawatts)                                           */
  update(d, time) {
    const T = this.theme;
    const { ownedH, ownedN, poweredH, poweredN, reserved, option, spot, mw, mwPending,
            served, training, unserved, demand } = d;

    // --- the shed grows with the fleet, and lights along what has power
    const fleet = ownedH + ownedN * 2;
    const live = poweredH + poweredN * 2;
    this.len += (shedLength(fleet) - this.len) * 0.12;
    const L = this.len;

    this.shell.scale.x = L;
    for (const r of this.roofs) r.scale.x = L + EAVE * 2;
    this.ridge.scale.x = L + EAVE * 2 + 0.1;
    this.pad.scale.set(L + 3.0, 1, SHED_W + 5);

    for (let i = 0; i < this.doors.length; i++) {
      const x = (i - (this.doors.length - 1) / 2) * 2.9;
      const on = Math.abs(x) < L / 2 - 1.3;
      this.doors[i].visible = on;
      if (on) this.doors[i].position.x = x;
    }

    const litFrac = fleet > 0.01 ? Math.min(1, live / fleet) : 0;
    const pulse = 0.55 + 0.16 * Math.sin(time * 1.7);
    for (const v of this.vents) {
      v.scale.x = Math.max(0.001, litFrac * (L - 1.2));
      v.position.x = -(L - 1.2) / 2;
      v.visible = litFrac > 0.01;
      v.material.color.lerp(new THREE.Color(litFrac > 0 ? this.color : T.trim), 0.12);
      v.material.emissive.lerp(new THREE.Color(litFrac > 0 ? this.color : 0x000000), 0.12);
      v.material.emissiveIntensity += ((litFrac > 0 ? pulse * T.emissive : 0) - v.material.emissiveIntensity) * 0.15;
    }

    // rooftop plant: one unit per thousand gen N on site
    const units = Math.min(this.plant.length, Math.ceil(ownedN - 1e-6));
    for (let i = 0; i < this.plant.length; i++) {
      const on = i < units;
      this.plant[i].visible = on;
      if (on) this.plant[i].position.x = (i - (units - 1) / 2) * 2.6;
    }

    if (!this.gauges) return this.spin();

    // --- the site around it
    for (let i = 0; i < this.spots.length; i++) {
      const on = spot > i * 0.9;
      this.spots[i].visible = on;
      this.spots[i].position.x = -(L / 2 + 2.2);
      if (on) this.spots[i].material.opacity = 0.28 + 0.3 * Math.abs(Math.sin(time * 3 + i));
    }

    const put = (mesh, x, w) => {
      mesh.visible = w > 0.02;
      mesh.position.x = x;
      mesh.scale.x += (Math.max(0.02, w) - mesh.scale.x) * 0.2;
    };
    this.bar.position.set(-(served + training + Math.max(0, unserved)) * KH / 2, DECK + 0.06, SHED_W / 2 + 3.4);
    put(this.segServed, 0, served * KH);
    put(this.segTrain, served * KH, training * KH);
    put(this.segUnserved, (served + training) * KH, unserved * KH);
    this.tick.position.x = demand * KH;
    this.tick.material.emissiveIntensity = (unserved > 0.01 ? 1.6 : 0.8) * T.emissive;

    this.spin();
  }

  // the event rings, which run on their own clock
  spin() {
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
