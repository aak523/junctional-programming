/* Capacity options, as an object.

   Keys. An option is the right to open a door later, at a price agreed now — you pay for
   the key whether or not you ever turn it, and a key you never turn is simply money you
   spent on nothing.

   One key is 2 kH of the right. They lie on the bench while you hold them, stand turned
   and lit once exercised, and go dark grey the moment month 23 passes with the key still
   lying there.

   Built here, on its own, so it can be worked on alone (viz/option.html) and dropped into
   a page by the caller, which positions it and owns its labels.

   Read it as a gauge:
     keys lying flat = the right you are holding   · turned and lit = exercised
     dark grey       = expired, the premium gone for nothing                             */
import * as THREE from 'three';
import { STATUS } from './campus3d.js';

// --- the real constants, from world.py --------------------------------------------------
export const OPTION_PREMIUM = 1.0;    // $M per kH, paid when you buy the key
export const OPTION_STRIKE = 1.6;     // $M per kH-month, fixed, when you turn it
export const OPTION_TERM = 6;         // months the exercised contract runs
export const OPTION_CAP = 20.0;       // kH of keys you may buy in a month
export const T_HORIZON = 24;          // past month 23 an unturned key is worthless

// --- dimensions -------------------------------------------------------------------------
export const DECK = 0.5;              // plinth thickness, as the campus apron
export const PER_KEY = 2.0;           // kH to a key
export const KEY_LEN = 2.6;
export const PITCH = 1.15;
export const ROW = 8;                 // keys to a row before it wraps
export const PAD_R = 8.0;

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// --- geometry built once and shared ------------------------------------------------------
const padGeo = new THREE.BoxGeometry(1, DECK, 1);
padGeo.translate(0, DECK / 2, 0);
/* a key: a round bow, a shaft, and two teeth at the end. Built lying along +x with the
   bow at the origin, so turning it is a rotation about x. */
const keyGeo = (() => {
  const parts = [];
  const bow = new THREE.TorusGeometry(0.42, 0.11, 6, 16);
  parts.push(bow);
  const shaft = new THREE.BoxGeometry(KEY_LEN, 0.15, 0.15);
  shaft.translate(KEY_LEN / 2 + 0.3, 0, 0);
  parts.push(shaft);
  for (const x of [0.55, 0.85]) {
    const tooth = new THREE.BoxGeometry(0.16, 0.42, 0.15);
    tooth.translate(KEY_LEN * 0.62 + x, -0.22, 0);
    parts.push(tooth);
  }
  // merge by hand: three.js BufferGeometryUtils is not vendored, so build one buffer
  let n = 0;
  for (const p of parts) n += p.attributes.position.count;
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3);
  const idx = [];
  let off = 0;
  for (const p of parts) {
    const pp = p.attributes.position, pn = p.attributes.normal;
    pos.set(pp.array, off * 3);
    nor.set(pn.array, off * 3);
    const pi = p.index ? Array.from(p.index.array) : [...Array(pp.count).keys()];
    for (const i of pi) idx.push(i + off);
    off += pp.count;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setIndex(idx);
  return g;
})();

export class Options {
  /* theme · metal: v => v so a paper key flattens metalness */
  constructor({ theme, metal = v => v }) {
    const T = this.theme = theme;
    this.group = new THREE.Group();
    const add = m => { this.group.add(m); return m; };
    const std = (c, o = {}) => new THREE.MeshStandardMaterial({
      color: c, roughness: o.rough ?? 0.5, metalness: metal(o.metal ?? 0.55),
      emissive: o.emissive ?? 0x000000, emissiveIntensity: (o.emi ?? 0) * T.emissive });

    this.pad = add(new THREE.Mesh(padGeo, std(T.pad, { rough: 0.92, metal: 0.1 })));
    this.pad.scale.set(PAD_R * 2, 1, 12);
    this.pad.receiveShadow = true;

    this.keys = [];
    for (let i = 0; i < 24; i++) {
      const k = add(new THREE.Mesh(keyGeo, std(T.trim, { rough: 0.4, metal: 0.6 })));
      k.position.set(0, DECK + 0.45, 0);
      k.castShadow = true;
      k.visible = false;
      this.keys.push(k);
    }
  }

  /* d: pool (kH of unexercised right) · exercised: [{ qty, site, start, end }]
        month · boughtThisMonth is accepted and ignored                              */
  update(d, time) {
    const T = this.theme;
    const { month = 0 } = d;
    const pool = d.pool ?? 0;
    const exercised = d.exercised || [];
    const pulse = 0.6 + 0.2 * Math.sin(time * 1.6);
    const dead = month >= T_HORIZON - 1;          // nothing unturned is worth anything now

    // the keys you have turned come first, then the ones still lying on the bench
    const turned = clamp(Math.round(exercised.reduce((s, e) => s + e.qty, 0) / PER_KEY),
                         0, this.keys.length);
    const held = clamp(Math.round(pool / PER_KEY), 0, this.keys.length - turned);
    const total = turned + held;

    for (let i = 0; i < this.keys.length; i++) {
      const k = this.keys[i];
      k.visible = i < total;
      if (!k.visible) continue;
      const isTurned = i < turned;
      // a held key lies flat on the bench; a turned one stands up in its lock. They are
      // laid out apart, and a lying key needs its whole length of room.
      k.rotation.set(isTurned ? 0 : -Math.PI / 2, 0, isTurned ? Math.PI / 2 : 0);
      if (isTurned) {
        k.position.set((i - (turned - 1) / 2) * PITCH, DECK + 0.5, -2.2);
      } else {
        const j = i - turned, col = j % 4, row = Math.floor(j / 4);
        k.position.set((col - (Math.min(held, 4) - 1) / 2) * 3.6 - 1.4,
                       DECK + 0.12, 1.4 + row * 1.5);
      }
      const c = isTurned ? STATUS.warning : (dead ? T.towerOff : T.trim);
      k.material.color.lerp(new THREE.Color(c), 0.12);
      k.material.emissive.lerp(new THREE.Color(isTurned ? STATUS.warning : 0x000000), 0.12);
      k.material.emissiveIntensity = (isTurned ? pulse : 0) * T.emissive;
    }
  }
}
