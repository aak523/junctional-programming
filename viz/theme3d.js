/* The two keys of the design, in 3D colour. The CSS side of the same palette lives in
   tokens.css; keep them in step. Picked from the URL at load time so every material is
   built once, in the right key. */

export const THEMES = {
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

export const css = hex => '#' + hex.toString(16).padStart(6, '0');

/* Reads the key off the URL, stamps it on <html> for the CSS, and hands back the
   3D palette plus the one correction the paper key needs: nothing on it is metal. */
export function useTheme() {
  const key = new URLSearchParams(location.search).get('theme') === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = key;
  const LIGHT = key === 'light';
  return { key, LIGHT, T: THEMES[key], css, metal: v => (LIGHT ? v * 0.12 : v) };
}
