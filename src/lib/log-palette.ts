// One palette for every figure on every log variant, taken from the drawing set's own tokens in
// styles/schematic.css. The chart libraries cannot read CSS custom properties at build time, so
// the values live here once rather than being retyped per renderer.
export const palette = {
  bg: '#0f1f3a',
  panel: '#132646',
  ink: '#e7edf7',
  muted: '#a3b3cb',
  faint: '#6d829f',
  line: 'rgba(201, 214, 234, .16)',
  line2: 'rgba(201, 214, 234, .34)',
  accent: '#e8933f',
  /** The recessive "before" bar. */
  dim: '#6c7f9c',
  /** Parts of one measure, light to dark, one hue. */
  stack: ['#f6c48b', '#e8933f', '#a6621f'],
} as const;

export const mono = '"IBM Plex Mono", ui-monospace, monospace';
export const fmt = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(v < 10 ? 2 : 1));
