// Variant 5. D3's scale and shape modules do the arithmetic during the build and the SVG is
// written out as a string: no DOM on the server, no D3 in the browser. Print-minded output,
// hairline rules and ink fills, so a page printed on paper looks like the page on screen.
import { scaleBand, scaleLinear } from 'd3-scale';
import { line as d3line } from 'd3-shape';
import type { Figure } from '../data/log/startup-halved';

import { palette } from './log-palette';

const INK = palette.ink;
const MUTED = palette.muted;
const RULE = 'rgba(201, 214, 234, .18)';
const ACCENT = palette.accent;
const DIM = palette.dim;
const STACK = palette.stack;

const fmt = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(v < 10 ? 2 : 1));
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const total = (values: (number | null)[]) => values.reduce<number>((a, b) => a + (b ?? 0), 0);

/** One figure, laid out with d3 scales and serialised to an SVG string. */
export function paperFigure(figure: Figure, width = 760): string {
  const grouped = figure.series.length > 1 && !figure.stacked;
  // The label gutter follows the longest name, capped so a narrow plate keeps room to plot in.
  const gutter = figure.kind === 'line' ? 40 : Math.min(width * 0.32, Math.max(...figure.rows.map((r) => r.label.length)) * 6.6 + 16);
  const right = width < 640 ? 58 : 68;
  const top = figure.kind === 'line' ? 30 : 10;
  const bottom = figure.kind === 'line' ? 58 : 30;
  const height = figure.kind === 'line' ? 300 : figure.rows.length * (grouped ? 46 : 34) + top + bottom;

  const reach = Math.max(...figure.rows.map((row) => (figure.stacked ? total(row.values) : Math.max(...row.values.map((v) => v ?? 0)))));
  const value = scaleLinear().domain([0, reach * 1.04]).nice().range([gutter, width - right]);
  const parts: string[] = [];
  const text = (x: number, y: number, body: string, options: { anchor?: string; fill?: string; size?: number } = {}) =>
    `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="${options.anchor ?? 'start'}" fill="${options.fill ?? INK}" font-size="${options.size ?? 12}">${esc(body)}</text>`;

  if (figure.kind === 'line') {
    const across = scaleLinear().domain([0, figure.rows.length - 1]).range([gutter, width - right]);
    const up = scaleLinear().domain([0, reach * 1.08]).nice().range([height - bottom, top]);
    up.ticks(4).forEach((tick) => {
      parts.push(`<line x1="${gutter}" x2="${width - right}" y1="${up(tick)}" y2="${up(tick)}" stroke="${RULE}" />`);
      parts.push(text(gutter - 10, up(tick) + 4, fmt(tick), { anchor: 'end', fill: MUTED, size: 11 }));
    });
    const path = d3line<{ i: number; v: number }>().x((d) => across(d.i)).y((d) => up(d.v))(
      figure.rows.map((row, i) => ({ i, v: row.values[0] ?? 0 })));
    parts.push(`<path d="${path}" fill="none" stroke="${ACCENT}" stroke-width="1.6" />`);
    figure.rows.forEach((row, i) => {
      const v = row.values[0] ?? 0;
      parts.push(`<circle cx="${across(i)}" cy="${up(v)}" r="4" fill="${row.hot ? ACCENT : palette.bg}" stroke="${ACCENT}" stroke-width="1.6" />`);
      parts.push(text(across(i), up(v) - 14, fmt(v), { anchor: 'middle', size: 12 }));
      parts.push(text(across(i), height - bottom + 20, row.label, { anchor: 'middle', fill: MUTED, size: 11 }));
      (row.tag ?? '').split(', ').forEach((word, k) => {
        parts.push(text(across(i), height - bottom + 36 + k * 13, word, { anchor: 'middle', fill: MUTED, size: 10 }));
      });
    });
    parts.push(`<line x1="${gutter}" x2="${width - right}" y1="${up(0)}" y2="${up(0)}" stroke="${INK}" />`);
    return wrap(parts, width, height);
  }

  const band = scaleBand<string>()
    .domain(figure.rows.map((row, i) => `${i}`))
    .range([top, height - bottom])
    .paddingInner(grouped ? 0.34 : 0.42);

  value.ticks(5).forEach((tick) => {
    parts.push(`<line x1="${value(tick)}" x2="${value(tick)}" y1="${top}" y2="${height - bottom}" stroke="${RULE}" />`);
    parts.push(text(value(tick), height - bottom + 18, fmt(tick), { anchor: 'middle', fill: MUTED, size: 11 }));
  });

  figure.rows.forEach((row, r) => {
    const y0 = band(`${r}`) ?? 0;
    const thickness = grouped ? band.bandwidth() / 2 - 2 : Math.min(band.bandwidth(), 14);
    const middle = y0 + band.bandwidth() / 2;
    parts.push(text(gutter - 12, middle + (row.tag ? -1 : 4), row.label, { anchor: 'end', fill: row.hot ? ACCENT : INK, size: 12 }));
    if (row.tag) parts.push(text(gutter - 12, middle + 13, row.tag, { anchor: 'end', fill: MUTED, size: 10 }));

    if (figure.stacked) {
      let at = value(0);
      row.values.forEach((v, i) => {
        if (v == null) return;
        const w = value(v) - value(0);
        parts.push(`<rect x="${at.toFixed(1)}" y="${(middle - thickness / 2).toFixed(1)}" width="${Math.max(w - 1.5, 1).toFixed(1)}" height="${thickness.toFixed(1)}" fill="${STACK[i]}" />`);
        at += w;
      });
      parts.push(text(value(total(row.values)) + 10, middle + 4, `${fmt(total(row.values))} ${figure.unit}`));
      return;
    }

    row.values.forEach((v, i) => {
      if (v == null) return;
      const y = grouped ? y0 + i * (thickness + 3) : middle - thickness / 2;
      const fill = grouped ? (i === 0 ? DIM : ACCENT) : row.hot ? ACCENT : DIM;
      parts.push(`<rect x="${value(0).toFixed(1)}" y="${y.toFixed(1)}" width="${(value(v) - value(0)).toFixed(1)}" height="${thickness.toFixed(1)}" fill="${fill}" />`);
      parts.push(text(value(v) + 10, y + thickness - 1, `${fmt(v)} ${figure.unit}`, { fill: grouped && i === 0 ? MUTED : INK, size: 11.5 }));
    });
  });

  parts.push(`<line x1="${value(0)}" x2="${value(0)}" y1="${top}" y2="${height - bottom}" stroke="${INK}" />`);
  return wrap(parts, width, height);
}

const wrap = (parts: string[], width: number, height: number) =>
  `<svg viewBox="0 0 ${width} ${Math.round(height)}" width="100%" role="img" font-family='"IBM Plex Mono", monospace'>${parts.join('')}</svg>`;
