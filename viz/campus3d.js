/* The campus: one site's data centre, as an object.

   Everything the globe knows about a site is encoded in this one piece of geometry —
   how much silicon is on the ground, how much of it is lit, what is rented beside it,
   how many megawatts are under it and how the month's demand was met. It is built here,
   on its own, so it can be studied on its own (viz/campus.html) and dropped onto the
   sphere by the caller (viz/world3d.js), which positions it and owns its labels.

   Read it as a gauge:
     tower height  = compute (FLOOR_H world units per kH)   · lit = powered
     crown         = gen N                                   · taller per unit, 2 kH each
     slabs         = rented capacity, left reserved, right an exercised option
     pillars       = spot fills this month
     substation    = energised MW, its wireframe ghost = contracted but not yet live
     ground bar    = served | training | unserved, with a tick at demand            */
import * as THREE from 'three';

export const PAD_R = 8;        // campus platform radius
export const PAD_TOP = 1.9;    // local height of the platform deck
export const FLOOR_H = 3.0;    // world units of tower per kH of compute
export const KH = 0.34;        // world units per kH on the ground gauge
export const STATUS = { good: 0x0ca30c, warning: 0xfab219, serious: 0xec835a, critical: 0xd03b3b };

const towerGeo = new THREE.BoxGeometry(1, 1, 1);
towerGeo.translate(0, 0.5, 0);
const crownGeo = new THREE.BoxGeometry(1, 1, 1);
crownGeo.translate(0, 0.5, 0);

export class Campus {
  /* theme: the key's colours (pad, towerOff, crown, sub, tick, emissive)
     color: the site's own colour · slots: how many tower pads to lay out
     metal: v => v, so a paper key can flatten every metalness in one place      */
  constructor({ theme, color, slots = 9, metal = v => v }) {
    const T = this.theme = theme;
    this.color = color;
    this.group = new THREE.Group();

    const pad = new THREE.Mesh(
      new THREE.CylinderGeometry(PAD_R, PAD_R - 1.2, 2.6, 64),
      new THREE.MeshStandardMaterial({ color: T.pad, roughness: 0.75, metalness: metal(0.25) })
    );
    pad.position.y = PAD_TOP - 1.3; pad.receiveShadow = true;
    this.group.add(pad);
    this.pad = pad;

    const rim = new THREE.Mesh(
      new THREE.TorusGeometry(PAD_R + 0.2, 0.11, 8, 96),
      new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 1.4 * T.emissive, roughness: 0.4 })
    );
    rim.rotation.x = Math.PI / 2; rim.position.y = PAD_TOP + 0.05;
    this.group.add(rim);
    this.rim = rim;

    // tower grid
    const n = Math.max(9, slots);
    const cols = Math.ceil(Math.sqrt(n));
    const span = (PAD_R * 1.42);
    const step = span / cols;
    this.step = step;
    this.towers = [];
    for (let i = 0; i < cols * cols; i++) {
      const cx = (i % cols - (cols - 1) / 2) * step;
      const cz = (Math.floor(i / cols) - (cols - 1) / 2) * step;
      const mat = new THREE.MeshStandardMaterial({ color: T.towerOff, emissive: 0x000000, roughness: 0.45, metalness: metal(0.35) });
      const m = new THREE.Mesh(towerGeo, mat);
      m.position.set(cx, PAD_TOP, cz);
      m.scale.set(step * 0.52, 0.001, step * 0.52);
      m.castShadow = true; m.receiveShadow = true;
      m.visible = false;
      const crown = new THREE.Mesh(crownGeo, new THREE.MeshStandardMaterial({
        color: T.crown, emissive: T.crown, emissiveIntensity: 0.5 * T.emissive, roughness: 0.4 }));
      crown.scale.set(1.12, 0.05, 1.12);
      crown.position.y = 1;        // sits on top in local (scaled) space
      crown.visible = false;
      m.add(crown);
      m.userData.crown = crown;
      this.group.add(m);
      this.towers.push(m);
    }

    // floating rented slabs
    const slab = (c, y, op) => {
      const mm = new THREE.Mesh(
        new THREE.BoxGeometry(1, 0.55, 6),
        new THREE.MeshStandardMaterial({ color: c, emissive: c, emissiveIntensity: 0.5 * T.emissive,
          transparent: true, opacity: op, roughness: 0.3 })
      );
      mm.position.set(0, y, 0); mm.visible = false;
      this.group.add(mm);
      return mm;
    };
    this.resSlab = slab(color, 7.5, 0.34);
    this.optSlab = slab(STATUS.warning, 7.5, 0.40);

    // spot pillars
    this.spots = [];
    for (let i = 0; i < 6; i++) {
      const p = new THREE.Mesh(
        new THREE.CylinderGeometry(0.16, 0.16, 7, 8, 1, true),
        new THREE.MeshStandardMaterial({ color, emissive: color,
          emissiveIntensity: 1.1 * T.emissive, transparent: true, opacity: 0.5, side: THREE.DoubleSide })
      );
      const a = -0.95 + i * 0.38;
      p.position.set(Math.sin(a) * (PAD_R - 1.0), PAD_TOP + 3.5, Math.cos(a) * (PAD_R - 1.0));
      p.visible = false;
      this.group.add(p);
      this.spots.push(p);
    }

    // substation: height = energised MW, ghost box = contracted but not yet live
    const sub = new THREE.Mesh(towerGeo, new THREE.MeshStandardMaterial({
      color: T.sub, emissive: STATUS.warning, emissiveIntensity: 0.14, roughness: 0.6, metalness: metal(0.5) }));
    sub.position.set(0, PAD_TOP, -(PAD_R + 2.6));
    sub.scale.set(2.8, 0.001, 2.8);
    sub.castShadow = true;
    this.group.add(sub);
    this.sub = sub;
    const ghost = new THREE.Mesh(towerGeo, new THREE.MeshBasicMaterial({
      color: STATUS.warning, wireframe: true, transparent: true, opacity: 0.35 }));
    ghost.position.copy(sub.position);
    ghost.scale.set(3.0, 0.001, 3.0);
    ghost.visible = false;
    this.group.add(ghost);
    this.ghost = ghost;

    // ground bar: served | training | unserved, with a demand tick
    this.bar = new THREE.Group();
    this.bar.position.set(0, PAD_TOP + 0.1, PAD_R + 2.0);
    this.group.add(this.bar);
    const seg = (c, op, emi) => {
      const g2 = new THREE.BoxGeometry(1, 0.4, 3.0);
      g2.translate(0.5, 0, 0);
      const mm = new THREE.Mesh(g2, new THREE.MeshStandardMaterial({
        color: c, emissive: c, emissiveIntensity: emi * T.emissive, transparent: op < 1, opacity: op, roughness: 0.5 }));
      mm.visible = false;
      this.bar.add(mm);
      return mm;
    };
    this.segServed = seg(color, 1, 0.75);
    this.segTrain = seg(color, 0.42, 0.3);
    this.segUnserved = seg(STATUS.critical, 1, 1.0);
    this.tick = new THREE.Mesh(
      new THREE.BoxGeometry(0.2, 1.1, 3.9),
      new THREE.MeshStandardMaterial({ color: T.tick, emissive: T.tick, emissiveIntensity: 0.9 * T.emissive })
    );
    this.bar.add(this.tick);

    // event ring pool (broker delivered / cancelled)
    this.rings = [];
    for (let i = 0; i < 3; i++) {
      const r = new THREE.Mesh(
        new THREE.TorusGeometry(1, 0.22, 8, 64),
        new THREE.MeshBasicMaterial({ color: STATUS.good, transparent: true, opacity: 0 })
      );
      r.rotation.x = Math.PI / 2; r.position.y = PAD_TOP + 0.3; r.visible = false;
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
    // towers: H first, then N
    const nH = Math.ceil(ownedH - 1e-6), nN = Math.ceil(ownedN - 1e-6);
    for (let i = 0; i < this.towers.length; i++) {
      const t = this.towers[i];
      let gen = null, frac = 0, lit = 0;
      if (i < nH) { gen = 'H'; frac = Math.min(1, ownedH - i); lit = Math.min(1, Math.max(0, poweredH - i)); }
      else if (i < nH + nN) { const j = i - nH; gen = 'N'; frac = Math.min(1, ownedN - j); lit = Math.min(1, Math.max(0, poweredN - j)); }
      if (!gen) { t.visible = false; continue; }
      t.visible = true;
      const compute = gen === 'N' ? 2 : 1;
      const target = Math.max(0.15, frac * compute * FLOOR_H);
      t.scale.y += (target - t.scale.y) * 0.16;
      const m = t.material;
      const want = lit > 0.5 ? this.color : T.towerOff;
      m.color.lerp(new THREE.Color(want), 0.12);
      m.emissive.lerp(new THREE.Color(lit > 0.5 ? this.color : 0x000000), 0.12);
      const pulse = 0.55 + 0.16 * Math.sin(time * 1.7 + i * 0.9);
      m.emissiveIntensity += ((lit > 0.5 ? pulse * T.emissive : 0) - m.emissiveIntensity) * 0.15;
      t.userData.crown.visible = gen === 'N';
    }
    // reserved / option slabs
    const slabW = (kh) => Math.max(0.001, kh * 0.8);
    this.resSlab.visible = reserved > 0.01;
    this.resSlab.scale.x += (slabW(reserved) - this.resSlab.scale.x) * 0.15;
    this.resSlab.position.set(-(PAD_R + 2.5 + this.resSlab.scale.x / 2), 7.5 + Math.sin(time * 0.8) * 0.4, 0);
    this.optSlab.visible = option > 0.01;
    this.optSlab.scale.x += (slabW(option) - this.optSlab.scale.x) * 0.15;
    this.optSlab.position.set(PAD_R + 2.5 + this.optSlab.scale.x / 2, 7.5 + Math.sin(time * 0.8 + 1.2) * 0.4, 0);
    // spot pillars
    for (let i = 0; i < this.spots.length; i++) {
      const on = spot > i * 0.9;
      this.spots[i].visible = on;
      if (on) this.spots[i].material.opacity = 0.28 + 0.3 * Math.abs(Math.sin(time * 3 + i));
    }
    // power
    const target = Math.max(0.001, mw * 0.22);
    this.sub.scale.y += (target - this.sub.scale.y) * 0.14;
    this.ghost.visible = mwPending > 0.01;
    if (this.ghost.visible) {
      const g = Math.max(0.001, (mw + mwPending) * 0.22);
      this.ghost.scale.y += (g - this.ghost.scale.y) * 0.14;
    }
    // ground bar
    const put = (mesh, x, w) => {
      mesh.visible = w > 0.02;
      mesh.position.x = x;
      mesh.scale.x += (Math.max(0.02, w) - mesh.scale.x) * 0.2;
    };
    this.bar.position.x = -(served + training + Math.max(0, unserved)) * KH / 2;
    put(this.segServed, 0, served * KH);
    put(this.segTrain, served * KH, training * KH);
    put(this.segUnserved, (served + training) * KH, unserved * KH);
    this.tick.position.x = demand * KH;
    this.tick.material.emissiveIntensity = (unserved > 0.01 ? 1.6 : 0.8) * T.emissive;
    // rings
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
