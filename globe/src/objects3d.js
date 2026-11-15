/* Ported from viz/*3d.js at origin/viz-state-objects by tools/port_objects.py. Do not edit by hand. */
const OBJ3D = {};
OBJ3D.theme = (() => {
/* The two keys of the design, in 3D colour. The CSS side of the same palette lives in
   tokens.css; keep them in step. Picked from the URL at load time so every material is
   built once, in the right key. */

const THEMES = {
  dark: {
    bg: 0x08090b, ocean: 0x0b0e12, land: 0x191d23,
    graticule: 0xffffff, gratA: 0.055, coast: 0xf2f1ec, coastA: 0.85,
    stars: false, pad: 0x101317, towerOff: 0x1b1f25, crown: 0xf2f1ec, hub: 0x14181d, steel: 0x6b7076,
    shed: 0x767d86, roof: 0x3c424a, trim: 0xaab1b9,
    sub: 0x272b31, tick: 0xf2f1ec, packet: 0xf2f1ec, lane: 0.07, laneHot: 0.38,
    emissive: 1, bloom: true, amb: 0.40, keyLight: 0.95, fillLight: 0.30, fillHue: 0x3f4a57,
    ink: '#f2f1ec', ink2: '#9a9a94', muted: '#5f5f5b', genN: '#8f86d8',
    site: { us: 0xf2f1ec, eu: 0xb6b6af, ap: 0x7c7c76 },
  },
  light: {
    bg: 0xf7f6f2, ocean: 0xe6eaee, land: 0xfbfaf7,
    graticule: 0x121211, gratA: 0.07, coast: 0x121211, coastA: 0.8,
    stars: false, pad: 0xefeee9, towerOff: 0xd6d5cf, crown: 0x121211, hub: 0xe6e5e0, steel: 0x56565a,
    shed: 0xdedcd6, roof: 0xc2c1ba, trim: 0x97968f,
    sub: 0xdcdbd5, tick: 0x121211, packet: 0x121211, lane: 0.20, laneHot: 0.75,
    emissive: 0.12, bloom: false, amb: 3.4, keyLight: 0.55, fillLight: 0.18, fillHue: 0xdfe2e4,
    ink: '#121211', ink2: '#56565a', muted: '#86868a', genN: '#4a3aa7',
    site: { us: 0x121211, eu: 0x56565a, ap: 0x8c8c90 },
  },
};

const css = hex => '#' + hex.toString(16).padStart(6, '0');

/* Reads the key off the URL, stamps it on <html> for the CSS, and hands back the
   3D palette plus the one correction the paper key needs: nothing on it is metal. */
function useTheme() {
  const key = new URLSearchParams(location.search).get('theme') === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = key;
  const LIGHT = key === 'light';
  return { key, LIGHT, T: THEMES[key], css, metal: v => (LIGHT ? v * 0.12 : v) };
}
return { THEMES, css, useTheme };
})();
OBJ3D.campus = (() => {
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

const SHED_W = 7.0;        // across the building
const WALL_H = 3.0;        // eaves height above the deck
const ROOF_RISE = 2.0;     // ridge above the eaves
const EAVE = 0.45;         // roof overhang
const DECK = 0.5;          // apron thickness: the building's floor
const LEN_BASE = 9.0;      // length at an empty site
const LEN_PER_KH = 0.7;    // and how it grows
const LEN_MAX = 26.0;
const PAD_R = LEN_MAX / 2; // the footprint a site needs, for callers that space things out
const KH = 0.34;           // world units per kH on the apron bar
const STATUS = { good: 0x0ca30c, warning: 0xfab219, serious: 0xec835a, critical: 0xd03b3b };

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const shedLength = kh => clamp(LEN_BASE + kh * LEN_PER_KH, LEN_BASE, LEN_MAX);

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

class Campus {
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
return { SHED_W, WALL_H, ROOF_RISE, EAVE, DECK, LEN_BASE, LEN_PER_KH, LEN_MAX, PAD_R, KH, STATUS, shedLength, Campus };
})();
OBJ3D.vendor = (() => {
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
const { STATUS } = OBJ3D.campus;

// --- the real constants, from world.py --------------------------------------------------
const MIN_LEAD = 3;          // an order placed in p first receives at the end of p+2
const ALLOC = { H: { loose: 6.0, tight: 2.0 }, N: { loose: 4.0, tight: 1.5 } };  // k/month
const EXPORT_ALLOC = 0.4;    // export controls multiply the H budget by this

// --- dimensions -------------------------------------------------------------------------
const COLS = 3;              // blocks across a line
const PITCH = 0.78;          // between block centres, both ways
const K = PITCH / COLS;      // world units per thousand GPUs, along a line
const DECK = 0.5;            // apron thickness, as the campus
const PLANT_W = 24.0;        // the hall, across
const PLANT_D = 10.0;        // the hall, deep
const PLANT_H = 6.0;         // to the eaves
const TEETH = 5;             // sawtooth bays across the depth
const STACKS = 3;            // chimneys
const STACK_H = 5.0;
const LANE_SEP = 11.0;       // between the two line centres
const LANE_MIN = 10.0;       // an empty line is still a length of apron
const BLOCK = 0.62;          // one thousand GPUs, as a block
const BLOCK_H = 0.62;
const SLOTS = 12;            // orders drawn per line, head of the line first
const BLOCKS = 90;           // blocks drawn per line before the tail is left out
const PAD_R = 32.0;          // footprint a caller should leave for the fab

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

class Vendor {
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
return { MIN_LEAD, ALLOC, EXPORT_ALLOC, COLS, PITCH, K, DECK, PLANT_W, PLANT_D, PLANT_H, TEETH, STACKS, STACK_H, LANE_SEP, LANE_MIN, BLOCK, BLOCK_H, SLOTS, BLOCKS, PAD_R, Vendor };
})();
OBJ3D.broker = (() => {
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
const { STATUS } = OBJ3D.campus;

// --- the real constants, from world.py --------------------------------------------------
const Q_HI = 0.9;            // fill probability while the broker is reliable
const Q_LO = 0.35;           // once unreliable, or once it has decayed
const REFUND = 0.8;          // of what you paid, on a cancellation
const CAP = 4.0;             // thousands per broker per month

// --- dimensions -------------------------------------------------------------------------
const DECK = 0.5;            // apron thickness, as the campus
const SHOP_W = 11.0;
const SHOP_D = 7.0;
const SHOP_H = 5.0;
const COUNTER_Z = 1.0;       // how far the counter stands off the shopfront
const BLOCK = 0.9;           // one thousand GPUs, as a block
const PITCH = 1.05;          // and the step between blocks
const ROW = 6;               // blocks to a row before it wraps back
const PAD_R = 10.0;          // footprint a caller should leave

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

class Broker {
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
return { Q_HI, Q_LO, REFUND, CAP, DECK, SHOP_W, SHOP_D, SHOP_H, COUNTER_Z, BLOCK, PITCH, ROW, PAD_R, Broker };
})();
OBJ3D.power = (() => {
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
const { STATUS } = OBJ3D.campus;

// --- the real constants, from world.py --------------------------------------------------
const POWER_TERM = 24;                                    // months, exclusive end
const T_HORIZON = 24;                                     // months 0..23; past it, settlement
const POWER_COST = { us: 0.15, eu: 0.20, ap: 0.12 };      // $M per MW-month
const POWER_MW = { H: 1.4, N: 1.6 };                      // MW per thousand GPUs
const POWER_LEAD = { us: [3, 8], eu: [4, 9], ap: [2, 6] };// lead range, pre-drawn per site

// --- dimensions -------------------------------------------------------------------------
const DECK = 0.5;          // apron thickness, as the campus
const MONTH = 0.62;        // world units per month along the term strip
const TOWER_H = 13.0;      // the tower at the reference contract
const REF_MW = 14;         // the contract size the tower is drawn at 1.0
const BASE_W = 3.0;        // leg spread at the ground
const WAIST_W = 1.25;      // and at the shoulders, where the arms start
const ARM_SPAN = 5.2;      // the widest crossarm
const MW_LINE = 0.40;      // world units of conductor per MW
const PAD_R = 13.0;        // the footprint a caller should leave

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/* world.py powers gen N first, then gives gen H whatever megawatts are left. */
function carried(mw, ownedH, ownedN) {
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

class Power {
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
return { POWER_TERM, T_HORIZON, POWER_COST, POWER_MW, POWER_LEAD, DECK, MONTH, TOWER_H, REF_MW, BASE_W, WAIST_W, ARM_SPAN, MW_LINE, PAD_R, carried, Power };
})();
OBJ3D.spot = (() => {
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
const { STATUS } = OBJ3D.campus;

// --- the real constants, from world.py --------------------------------------------------
const SPOT_CAP = { loose: { us: 5.0, eu: 4.0, ap: 3.0 },
                          tight: { us: 1.5, eu: 1.0, ap: 0.5 } };   // kH a month
const SPOT_MULT = { loose: 1.1, tight: 1.8 };
const SITE_PRICE = { us: 1.00, eu: 1.10, ap: 0.95 };
const SPIKE_CAP = 0.5;         // a rival lab buying halves what is on offer
const SPIKE_PRICE = 1.5;
const EXPORT_CAP = 0.6;        // export controls take a further 40% of supply

/* what the month will actually give you, and what it charges — the world's own formulas */
const capOf = (site, regime, spike, exportActive) =>
  SPOT_CAP[regime][site] * (spike ? SPIKE_CAP : 1) * (exportActive ? EXPORT_CAP : 1);
const priceOf = (cindex, regime, noise, spike, site) =>
  cindex * SPOT_MULT[regime] * noise * (spike ? SPIKE_PRICE : 1) * SITE_PRICE[site];

// --- dimensions -------------------------------------------------------------------------
const DECK = 0.5;          // plinth thickness, as the campus apron
const KH = 0.85;           // world units of bucket per kH
const BUCKET_R = 1.8;
const SPOUT_Y = 7.6;       // how high the tap stands over the bucket
const RISER_X = -4.0;      // and how far back, clear of the bucket
const PAD_R = 8.0;

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

class Spot {
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
return { SPOT_CAP, SPOT_MULT, SITE_PRICE, SPIKE_CAP, SPIKE_PRICE, EXPORT_CAP, capOf, priceOf, DECK, KH, BUCKET_R, SPOUT_Y, RISER_X, PAD_R, Spot };
})();
OBJ3D.contract = (() => {
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
const { STATUS } = OBJ3D.campus;

// --- the real constants, from world.py --------------------------------------------------
const T_HORIZON = 24;      // months 0..23; a month past it is settlement only
const TERM_FACTOR = { 6: 1.15, 12: 1.00, 24: 0.90 };
const SITE_PRICE = { us: 1.00, eu: 1.10, ap: 0.95 };

// --- dimensions -------------------------------------------------------------------------
const CARD_W = 9.0;        // the sheet
const CARD_H = 6.2;
const FLOAT_Y = 4.6;       // how high it hangs
const SQ = 0.78;           // a kH square
const SQ_GAP = 0.2;
const TICK_W = 0.26;       // a month mark
const TICK_GAP = 0.1;
const PAD_R = 7.0;

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// --- geometry built once and shared ------------------------------------------------------
const planeGeo = new THREE.PlaneGeometry(1, 1);
const ringGeo = new THREE.RingGeometry(0.34, 0.46, 24);
const discGeo = new THREE.CircleGeometry(0.34, 24);

class Contract {
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
return { T_HORIZON, TERM_FACTOR, SITE_PRICE, CARD_W, CARD_H, FLOAT_Y, SQ, SQ_GAP, TICK_W, TICK_GAP, PAD_R, Contract };
})();
