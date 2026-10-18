// Chart.js, themed to the drawing set and registered piece by piece so the bundle carries only
// the bar and line controllers. A chart is built the first time it scrolls into the frame, which
// is where its animation belongs, and destroyed before a view transition swaps the sheet out.
import {
  BarController, BarElement, CategoryScale, Chart, Filler, LineController, LineElement,
  LinearScale, PointElement, Tooltip,
} from 'chart.js';
import type { ChartType } from 'chart.js';

// The value-label plugin takes one option, so it gets declared rather than cast away.
declare module 'chart.js' {
  interface PluginOptionsByType<TType extends ChartType> { valueLabels?: { unit?: string } }
}

Chart.register(BarController, BarElement, LineController, LineElement, PointElement, CategoryScale, LinearScale, Tooltip, Filler);

export type ChartSpec = {
  kind: 'bar' | 'line';
  labels: (string | string[])[];
  series: { name: string; data: (number | null)[]; fill: 'accent' | 'dim' | 'light' | 'dark' | 'per-row' }[];
  perRow?: ('accent' | 'dim')[];   // one fill per row, for a single-series chart with an emphasis
  unit: string;
  stacked?: boolean;
  max?: number;
};

const token = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const fmt = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(v < 10 ? 2 : 1));

const colourOf = (fill: string) => token(fill === 'dim' ? '--c0' : fill === 'light' ? '--c2' : fill === 'dark' ? '--c3' : '--c1');

// Chart.js has no data labels of its own, and these charts are about the numbers, so the value
// rides just past the end of each bar and above each point.
const valueLabels = {
  id: 'valueLabels',
  afterDatasetsDraw(chart: Chart, _args: unknown, options: { unit?: string; last?: boolean }) {
    const { ctx } = chart;
    ctx.save();
    ctx.font = `12px ${token('--mono') || 'monospace'}`;
    ctx.fillStyle = token('--ink');
    ctx.textBaseline = 'middle';
    chart.data.datasets.forEach((dataset, i) => {
      const meta = chart.getDatasetMeta(i);
      if (meta.hidden) return;
      // A stacked chart labels the running total once, at the end of the last visible segment.
      const stacked = (chart.options.scales?.x as { stacked?: boolean } | undefined)?.stacked;
      if (stacked && i !== chart.data.datasets.length - 1) return;
      meta.data.forEach((element, index) => {
        const value = stacked
          ? chart.data.datasets.reduce((sum, d) => sum + (Number(d.data[index]) || 0), 0)
          : Number(dataset.data[index]);
        if (!Number.isFinite(value)) return;
        const text = `${fmt(value)} ${options.unit ?? ''}`.trim();
        if (chart.options.indexAxis === 'y') {
          // A segment with no value sits at the stack's base, so the total is printed past the
          // furthest segment drawn for this row, not past the last dataset.
          const end = stacked
            ? Math.max(...chart.data.datasets.map((_, di) => chart.getDatasetMeta(di).data[index]?.x ?? 0))
            : element.x;
          ctx.textAlign = 'left';
          ctx.fillText(text, end + 10, element.y);
        } else {
          // The first point sits against the value axis, so its label steps aside rather than
          // printing itself over a tick.
          ctx.textAlign = index === 0 ? 'left' : 'center';
          ctx.fillText(text, index === 0 ? element.x + 10 : element.x, element.y - 16);
        }
      });
    });
    ctx.restore();
  },
};

// Chart.js truncates a category label that does not fit, and on a phone that eats the front of
// every name. Wrapping to the room actually available keeps them whole instead.
function wrap(label: string | string[], limit: number): string | string[] {
  if (Array.isArray(label)) return label.flatMap((line) => wrap(line, limit));
  if (label.length <= limit) return label;
  const lines: string[] = [];
  for (const word of label.split(' ')) {
    const last = lines[lines.length - 1];
    if (last && `${last} ${word}`.length <= limit) lines[lines.length - 1] = `${last} ${word}`;
    else lines.push(word);
  }
  return lines;
}

function build(canvas: HTMLCanvasElement, spec: ChartSpec) {
  // Read the width from the wrapper: a canvas Chart.js has not sized yet reports its intrinsic
  // 300px, which would wrap every label as if the sheet were a phone.
  const width = canvas.parentElement?.clientWidth ?? canvas.clientWidth;
  const grid = token('--line');
  // Axis text sits a step behind the labels on the marks themselves.
  const muted = 'rgba(163, 179, 203, .62)';
  const bar = spec.kind === 'bar';
  const datasets = spec.series.map((series) => {
    const colours = spec.perRow ? spec.perRow.map(colourOf) : colourOf(series.fill);
    return bar
      ? { label: series.name, data: series.data, backgroundColor: colours, borderWidth: 0, barThickness: 10, borderSkipped: false as const }
      : {
          label: series.name, data: series.data, borderColor: colourOf(series.fill), borderWidth: 2,
          pointBackgroundColor: token('--bg'), pointBorderColor: colourOf(series.fill), pointBorderWidth: 2,
          pointRadius: 5, pointHoverRadius: 7, tension: 0,
        };
  });
  const reach = Math.max(...(spec.stacked
    ? spec.labels.map((_, i) => spec.series.reduce((sum, series) => sum + (series.data[i] ?? 0), 0))
    : spec.series.flatMap((series) => series.data.map((v) => v ?? 0))));
  // A hard ceiling just past the longest bar, so the plot is not a third empty because Chart.js
  // rounded 718 up to a tidy 1,000.
  const value = { stacked: spec.stacked, max: spec.max ?? reach * 1.08, beginAtZero: true, border: { color: token('--line-2') }, grid: { color: grid, drawTicks: false }, ticks: { color: muted, padding: 8, maxTicksLimit: 5, font: { family: token('--mono'), size: 11 } } };
  const category = { stacked: spec.stacked, border: { color: token('--line-2') }, grid: { display: false }, ticks: { color: muted, autoSkip: false, font: { family: token('--mono'), size: 12 } } };
  return new Chart(canvas, {
    type: spec.kind,
    data: { labels: bar ? spec.labels.map((label) => wrap(label, width < 560 ? 12 : 22)) : spec.labels, datasets },
    options: {
      indexAxis: bar ? 'y' : 'x',
      maintainAspectRatio: false,
      animation: reduced() ? false : { duration: 800, easing: 'easeOutQuart' },
      // Room on the value side for the label that sits past the last bar or above the top point.
      layout: { padding: bar ? { right: width < 560 ? 56 : 76, top: 4 } : { top: 30, right: 16 } },
      scales: bar ? { x: value, y: category } : { x: category, y: value },
      plugins: {
        legend: { display: false },
        valueLabels: { unit: spec.unit },
        tooltip: {
          backgroundColor: token('--bg'), borderColor: token('--accent'), borderWidth: 1, cornerRadius: 0,
          titleColor: token('--ink'), bodyColor: token('--muted'), displayColors: false, padding: 10,
          titleFont: { family: token('--mono'), size: 12, weight: 'normal' }, bodyFont: { family: token('--mono'), size: 12 },
          callbacks: {
            label: (item) => `${spec.series.length > 1 ? `${item.dataset.label}: ` : ''}${fmt(Number(item.raw))} ${spec.unit}`,
          },
        },
      },
    },
    plugins: [valueLabels],
  });
}

const live = new Map<HTMLCanvasElement, Chart>();
let observer: IntersectionObserver | null = null;

export function initCharts() {
  observer?.disconnect();
  const canvases = document.querySelectorAll<HTMLCanvasElement>('canvas[data-chart]');
  if (!canvases.length) return;
  const start = (canvas: HTMLCanvasElement) => {
    if (live.has(canvas)) return;
    live.set(canvas, build(canvas, JSON.parse(canvas.dataset.chart!) as ChartSpec));
  };
  observer = new IntersectionObserver((entries) => entries.forEach((entry) => {
    if (!entry.isIntersecting) return;
    start(entry.target as HTMLCanvasElement);
    observer?.unobserve(entry.target);
  }), { threshold: 0.25 });
  canvases.forEach((canvas) => observer!.observe(canvas));
}

// A view transition throws the old sheet's canvases away; a chart still holding one leaks its
// resize listener and its animation frame.
document.addEventListener('astro:before-swap', () => {
  observer?.disconnect();
  observer = null;
  live.forEach((chart) => chart.destroy());
  live.clear();
});
