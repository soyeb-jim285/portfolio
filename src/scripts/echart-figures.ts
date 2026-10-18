// Variant 4. ECharts, imported only once a panel scrolls into view, and only the pieces this page
// draws with: bars, a line, grid, tooltip. Each figure carries its spec in a data attribute.
import type { Figure } from '../data/log/startup-halved';
import { fmt, mono, palette } from '../lib/log-palette';

const INK = palette.ink;
const MUTED = palette.muted;
const LINE = 'rgba(201, 214, 234, .16)';
const ACCENT = palette.accent;
const DIM = palette.dim;
const STACK = palette.stack;

type ECharts = typeof import('echarts');

function option(figure: Figure, echarts: ECharts) {
  const labels = figure.rows.map((row) => row.label);
  const text = { color: MUTED, fontFamily: mono, fontSize: 11 };
  const shared = {
    animationDuration: 700,
    textStyle: { fontFamily: mono },
    grid: { left: 8, right: 74, top: 16, bottom: 26, containLabel: true },
    tooltip: {
      trigger: 'item' as const,
      backgroundColor: palette.bg,
      borderColor: LINE,
      textStyle: { color: INK, fontFamily: mono, fontSize: 12 },
      valueFormatter: (value: number) => `${fmt(value)} ${figure.unit}`,
    },
  };

  if (figure.kind === 'line') {
    return {
      ...shared,
      grid: { left: 8, right: 30, top: 42, bottom: 44, containLabel: true },
      xAxis: { type: 'category', data: labels, axisLine: { lineStyle: { color: LINE } }, axisTick: { show: false }, axisLabel: text },
      yAxis: { type: 'value', splitLine: { lineStyle: { color: LINE } }, axisLabel: text, name: figure.unit, nameTextStyle: { color: MUTED, fontFamily: mono, fontSize: 11 } },
      series: [{
        type: 'line',
        data: figure.rows.map((row) => row.values[0] ?? 0),
        symbolSize: 9,
        lineStyle: { color: ACCENT, width: 2 },
        itemStyle: { color: palette.bg, borderColor: ACCENT, borderWidth: 2 },
        label: { show: true, position: 'top', distance: 10, color: INK, fontFamily: mono, fontSize: 12, formatter: (p: { value: number }) => fmt(p.value) },
        areaStyle: {
          color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
            { offset: 0, color: 'rgba(232, 147, 63, .22)' },
            { offset: 1, color: 'rgba(232, 147, 63, 0)' },
          ]),
        },
      }],
    };
  }

  const series = figure.series.map((name, i) => ({
    type: 'bar' as const,
    name,
    stack: figure.stacked ? 'one' : undefined,
    barWidth: figure.series.length > 1 && !figure.stacked ? 11 : 13,
    barGap: '20%',
    data: figure.rows.map((row) => ({
      value: row.values[i] ?? 0,
      itemStyle: {
        color: figure.stacked ? STACK[i] : figure.series.length > 1 ? (i === 0 ? DIM : ACCENT) : row.hot ? ACCENT : DIM,
      },
    })),
    label: figure.stacked && i !== figure.series.length - 1 ? { show: false } : {
      show: true,
      position: 'right' as const,
      distance: 10,
      color: INK,
      fontFamily: mono,
      fontSize: 12,
      formatter: figure.stacked
        ? (p: { dataIndex: number }) => `${fmt(figure.rows[p.dataIndex].values.reduce<number>((a, b) => a + (b ?? 0), 0))} ${figure.unit}`
        : (p: { value: number }) => `${fmt(p.value)} ${figure.unit}`,
    },
  }));

  return {
    ...shared,
    xAxis: { type: 'value', splitLine: { lineStyle: { color: LINE } }, axisLabel: text },
    yAxis: { type: 'category', inverse: true, data: labels, axisLine: { lineStyle: { color: LINE } }, axisTick: { show: false }, axisLabel: { ...text, fontSize: 12 } },
    series,
  };
}

export async function initPanels() {
  const nodes = document.querySelectorAll<HTMLElement>('[data-figure]');
  if (!nodes.length) return;
  let echarts: ECharts | null = null;
  const draw = async (node: HTMLElement) => {
    echarts ??= await import('echarts');
    const figure = JSON.parse(node.dataset.figure!) as Figure;
    const chart = echarts.init(node, undefined, { renderer: 'canvas' });
    chart.setOption(option(figure, echarts) as Parameters<typeof chart.setOption>[0]);
    new ResizeObserver(() => chart.resize()).observe(node);
  };
  const seen = new IntersectionObserver((entries) => entries.forEach((entry) => {
    if (!entry.isIntersecting) return;
    void draw(entry.target as HTMLElement);
    seen.unobserve(entry.target);
  }), { rootMargin: '120px' });
  nodes.forEach((node) => seen.observe(node));
}
