// Variant 3. Recharts in a React island, hydrated when the figure scrolls into view. Recharts
// draws SVG rather than canvas, so the bars stay selectable and the tooltip is ordinary DOM.
import {
  Bar, BarChart, CartesianGrid, Cell, LabelList, Line, LineChart, ResponsiveContainer,
  Tooltip, XAxis, YAxis,
} from 'recharts';
import type { Figure } from '../../data/log/startup-halved';

import { fmt, palette } from '../../lib/log-palette';

const ink = palette.ink;
const muted = palette.muted;
const grid = 'rgba(201, 214, 234, .16)';
const accent = palette.accent;
const dim = palette.dim;
const stack = palette.stack;
const axis = { stroke: grid, tick: { fill: muted, fontSize: 11, fontFamily: 'var(--mono)' }, tickLine: false };

export default function RechartsFigure({ figure }: { figure: Figure }) {
  const data = figure.rows.map((row) => {
    const point: Record<string, string | number | null> = { label: row.label, hot: row.hot ? 1 : 0 };
    // A stacked row whose last part is absent still needs that segment to exist, or the total
    // label has no bar to sit against and silently disappears.
    figure.series.forEach((name, i) => { point[name] = row.values[i] ?? (figure.stacked ? 0 : null); });
    return point;
  });
  const height = figure.kind === 'line' ? 300 : Math.max(180, figure.rows.length * (figure.series.length > 1 && !figure.stacked ? 52 : 38) + 48);
  const tooltip = (
    <Tooltip
      cursor={{ fill: 'rgba(232, 147, 63, .08)' }}
        contentStyle={{ background: palette.bg, border: `1px solid ${palette.line2}`, borderRadius: 0, fontFamily: 'var(--mono)', fontSize: 12, color: ink }}
      labelStyle={{ color: muted }}
      formatter={(value, name) => [`${fmt(Number(value))} ${figure.unit}`, String(name)]}
    />
  );

  if (figure.kind === 'line') {
    return (
      <ResponsiveContainer width="100%" height={height}>
        <LineChart data={data} margin={{ top: 26, right: 24, bottom: 8, left: 0 }}>
          <CartesianGrid stroke={grid} vertical={false} />
          <XAxis dataKey="label" {...axis} />
          <YAxis {...axis} width={46} unit="" />
          {tooltip}
          <Line
            type="linear" dataKey={figure.series[0]} stroke={accent} strokeWidth={2}
            dot={{ fill: palette.bg, stroke: accent, strokeWidth: 2, r: 4 }} activeDot={{ r: 6 }} isAnimationActive
          >
            <LabelList dataKey={figure.series[0]} position="top" offset={12} fill={ink} fontSize={12} fontFamily="var(--mono)" />
          </Line>
        </LineChart>
      </ResponsiveContainer>
    );
  }

  const widest = Math.max(...figure.rows.map((row) => row.label.length));
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} layout="vertical" margin={{ top: 8, right: 72, bottom: 8, left: 0 }} barGap={3}>
        <CartesianGrid stroke={grid} horizontal={false} />
        <XAxis type="number" {...axis} />
        <YAxis type="category" dataKey="label" {...axis} width={Math.min(190, widest * 7 + 16)} />
        {tooltip}
        {figure.series.map((name, i) => (
          <Bar
            key={name} dataKey={name} stackId={figure.stacked ? 'one' : undefined}
            fill={figure.stacked ? stack[i] : figure.series.length > 1 ? (i === 0 ? dim : accent) : accent}
            barSize={figure.series.length > 1 && !figure.stacked ? 12 : 14} radius={figure.stacked ? 0 : 2}
          >
            {/* A single-series chart says which row the paragraph is about by colour. */}
            {figure.series.length === 1 && data.map((point, r) => (
              <Cell key={r} fill={point.hot ? accent : dim} />
            ))}
            {(!figure.stacked || i === figure.series.length - 1) && (
              <LabelList
                dataKey={figure.stacked ? undefined : name}
                position="right" offset={10} fill={ink} fontSize={12} fontFamily="var(--mono)"
                formatter={(value) => `${fmt(Number(value))} ${figure.unit}`}
                valueAccessor={figure.stacked
                  ? (entry: { payload: Record<string, number | null> }) =>
                      figure.series.reduce((sum, key) => sum + (entry.payload[key] ?? 0), 0)
                  : undefined}
              />
            )}
          </Bar>
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}
