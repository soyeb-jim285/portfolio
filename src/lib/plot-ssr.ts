// Variant 2 renders Observable Plot during the build. Plot needs a DOM to draw into, so one
// jsdom window is created per build and handed to it; the result is an SVG string that ships as
// markup, with no Plot, no D3 and no jsdom in the browser bundle.
import * as Plot from '@observablehq/plot';
import { JSDOM } from 'jsdom';
import type { Figure } from '../data/log/startup-halved';

const dom = new JSDOM('<!doctype html><html><body></body></html>');
const document = dom.window.document;

// Plot reads these off globalThis while it measures text and builds nodes.
type PlotGlobals = { document?: Document; window?: unknown; navigator?: unknown };
const globals = globalThis as PlotGlobals;
globals.document ??= document as unknown as Document;
globals.window ??= dom.window;
globals.navigator ??= dom.window.navigator;

import { palette as sheet } from './log-palette';

const ink = sheet.ink;
const faint = sheet.muted;
const rule = 'rgba(201, 214, 234, .22)';
const palette = { accent: sheet.accent, dim: sheet.dim, light: sheet.stack[0], dark: sheet.stack[2] };

type Row = { label: string; value: number; series: string; hot: boolean };

const rowsOf = (figure: Figure): Row[] =>
  figure.rows.flatMap((row) =>
    row.values.flatMap((value, i) =>
      value == null ? [] : [{ label: row.label, value, series: figure.series[i] ?? figure.title, hot: Boolean(row.hot) }]));

const colourFor = (figure: Figure) => {
  if (figure.stacked) return [palette.light, palette.accent, palette.dark];
  if (figure.series.length > 1) return [palette.dim, palette.accent];
  return [palette.accent];
};

/** Render one figure to an SVG string, sized for the editorial column. */
export function renderFigure(figure: Figure, width = 720): string {
  const rows = rowsOf(figure);
  const common = {
    width,
    marginLeft: figure.kind === 'line' ? 52 : Math.min(190, Math.max(...figure.rows.map((r) => r.label.length)) * 7 + 18),
    marginRight: 64,
    marginTop: 18,
    marginBottom: figure.kind === 'line' ? 52 : 34,
    style: { background: 'transparent', color: ink, fontFamily: '"IBM Plex Mono", monospace', fontSize: '12px' },
  } as const;

  const mark = figure.kind === 'line'
    ? [
        Plot.ruleY([0], { stroke: rule }),
        Plot.line(figure.rows.map((row, i) => ({ i, label: row.label, value: row.values[0] ?? 0 })), { x: 'i', y: 'value', stroke: palette.accent, strokeWidth: 2 }),
        Plot.dot(figure.rows.map((row, i) => ({ i, value: row.values[0] ?? 0, hot: Boolean(row.hot) })), { x: 'i', y: 'value', r: 4.5, fill: (d: { hot: boolean }) => (d.hot ? palette.accent : sheet.bg), stroke: palette.accent, strokeWidth: 2 }),
        Plot.text(figure.rows.map((row, i) => ({ i, value: row.values[0] ?? 0 })), { x: 'i', y: 'value', text: (d: { value: number }) => String(d.value), dy: -16, fill: ink, fontSize: 13 }),
      ]
    : figure.stacked
      ? [
          // Stacked parts are stacked explicitly, in the order the entry lists them, and only the
          // running total is labelled; a label per segment is unreadable at this width.
          Plot.ruleX([0], { stroke: rule }),
          Plot.barX(rows, Plot.stackX({ x: 'value', y: 'label', fill: 'series', order: figure.series, insetTop: 2, insetBottom: 2 })),
          Plot.text(figure.rows.map((row) => ({ label: row.label, total: row.values.reduce<number>((a, b) => a + (b ?? 0), 0) })), {
            x: 'total', y: 'label', text: (d: { total: number }) => `${d.total.toFixed(d.total < 10 ? 1 : 1)} ${figure.unit}`,
            textAnchor: 'start', dx: 8, fill: ink, fontSize: 12,
          }),
        ]
      : [
          Plot.ruleX([0], { stroke: rule }),
          Plot.barX(rows, {
            x: 'value', y: 'label', fill: figure.series.length > 1 ? 'series' : (d: Row) => (d.hot ? 'hot' : 'rest'),
            fy: figure.series.length > 1 ? 'series' : undefined,
            insetTop: 2, insetBottom: 2, sort: null,
          }),
          Plot.text(rows, { x: 'value', y: 'label', fy: figure.series.length > 1 ? 'series' : undefined, text: (d: Row) => `${d.value} ${figure.unit}`, textAnchor: 'start', dx: 8, fill: ink, fontSize: 12 }),
        ];

  const scales = figure.kind === 'line'
    ? {
        x: { axis: 'bottom' as const, ticks: figure.rows.map((_, i) => i), tickFormat: (i: number) => figure.rows[i]?.label ?? '', label: null, grid: false },
        y: { grid: true, label: figure.unit, nice: true },
        color: { range: colourFor(figure) },
      }
    : {
        x: { grid: true, label: figure.unit, nice: true },
        // Plot would otherwise order the bars by value; the entry's order is the argument.
        y: { label: null, tickSize: 0, domain: figure.rows.map((row) => row.label) },
        // Two measures are faceted into small multiples; keep "before" above "after".
        fy: { label: null, tickSize: 0, axis: null, domain: figure.series },
        color: { range: figure.series.length > 1 ? colourFor(figure) : [palette.accent, palette.dim], domain: figure.series.length > 1 ? figure.series : ['hot', 'rest'] },
      };

  const chart = Plot.plot({ ...common, ...scales, marks: mark } as Parameters<typeof Plot.plot>[0]);
  const svg = (chart as unknown as { outerHTML: string }).outerHTML;
  // Plot writes its axis and label colours into a scoped class; keep the markup, drop the width
  // lock so the figure can breathe on a narrow screen.
  return svg
    .replace(/width="\d+"/, `viewBox="0 0 ${width} ${(chart as unknown as { getAttribute(name: string): string | null }).getAttribute('height') ?? 320}" width="100%"`)
    .replaceAll('#000', ink)
    .replaceAll('currentColor', faint);
}
