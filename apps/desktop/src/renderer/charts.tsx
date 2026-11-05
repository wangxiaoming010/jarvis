import { useEffect, useRef, useState } from 'react';
import type * as ECharts from 'echarts';
import { Button } from '@heroui/react';
import { Ellipsis } from 'lucide-react';
import { iosChartColors, iosMotion } from './ios-theme.generated';
import { formatValue } from './presentation';
import { useEntrance } from './motion';
export type Props = Record<string, any>;
const colors = [...iosChartColors];
// Depth styling shared by every chart: a light-to-deep gradient, a soft
// tinted shadow and a surface-coloured seam between adjacent marks.
function shade(hex: string, amount: number) {
  const n = parseInt(hex.slice(1, 7), 16);
  const mix = (c: number) => Math.round(amount < 0 ? c * (1 + amount) : c + (255 - c) * amount);
  return (
    '#' +
    [mix(n >> 16), mix((n >> 8) & 255), mix(n & 255)]
      .map((v) => v.toString(16).padStart(2, '0'))
      .join('')
  );
}
const alpha = (value: number) =>
  Math.round(value * 255)
    .toString(16)
    .padStart(2, '0');
const linear = (color: string, horizontal = false) => ({
  type: 'linear' as const,
  x: 0,
  y: 0,
  x2: horizontal ? 1 : 0,
  y2: horizontal ? 0 : 1,
  colorStops: [
    { offset: 0, color: shade(color, 0.32) },
    { offset: 0.55, color },
    { offset: 1, color: shade(color, -0.18) },
  ],
});
const sphere = (color: string) => ({
  type: 'radial' as const,
  x: 0.35,
  y: 0.3,
  r: 0.85,
  colorStops: [
    { offset: 0, color: shade(color, 0.55) },
    { offset: 0.5, color },
    { offset: 1, color: shade(color, -0.25) },
  ],
});
const fade = (color: string, top: number) => ({
  type: 'linear' as const,
  x: 0,
  y: 0,
  x2: 0,
  y2: 1,
  colorStops: [
    { offset: 0, color: color + alpha(top) },
    { offset: 1, color: color + '00' },
  ],
});
const lift = (color: string, blur = 10, y = 4) => ({
  shadowColor: color + '59',
  shadowBlur: blur,
  shadowOffsetY: y,
});
// cubic-bezier(.45, 0, .2, 1): the same soft S-curve as the chat animations.
// ECharts takes an easing function, so solve the bezier for x → progress.
function cubicBezier(x1: number, y1: number, x2: number, y2: number) {
  const at = (a: number, b: number, t: number) =>
    3 * a * t * (1 - t) ** 2 + 3 * b * t ** 2 * (1 - t) + t ** 3;
  return (x: number) => {
    if (x <= 0 || x >= 1) return x;
    let lo = 0,
      hi = 1,
      t = x;
    for (let i = 0; i < 24; i++) {
      t = (lo + hi) / 2;
      if (at(x1, x2, t) < x) lo = t;
      else hi = t;
    }
    return at(y1, y2, t);
  };
}
const easeSoft = cubicBezier(0.45, 0, 0.2, 1);
export function ChartView({ type, p }: { type: string; p: Props }) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<ECharts.ECharts | undefined>(undefined);
  const menuRef = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (menuRef.current?.open && !menuRef.current.contains(event.target as Node))
        menuRef.current.open = false;
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, []);
  const [showsTable, setShowsTable] = useState(false);
  const [reduced, setReduced] = useState(
    () => matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  useEffect(() => {
    const media = matchMedia('(prefers-reduced-motion: reduce)');
    const change = () => setReduced(media.matches);
    media.addEventListener('change', change);
    return () => media.removeEventListener('change', change);
  }, []);
  useEffect(
    () => () => {
      chartRef.current?.dispose();
      chartRef.current = undefined;
    },
    [],
  );
  const [range, setRange] = useState(p.defaultRangeId ?? p.ranges?.[0]?.id ?? '');
  const [theme, setTheme] = useState(document.documentElement.dataset.theme);
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(document.documentElement.dataset.theme));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    return () => observer.disconnect();
  }, []);
  const signature = JSON.stringify(p);
  const entrance = useEntrance();
  useEffect(() => {
    let active = true;
    let chart: ECharts.ECharts | undefined;
    let observer: ResizeObserver | undefined;
    if (showsTable) return;
    // Draw only once every enclosing entrance (message, card, page) has finished,
    // so the order is: bubble → chart surface → chart's own entrance animation.
    void Promise.all([import('echarts'), entrance]).then(([echarts]) => {
      if (!active || !ref.current) return;
      if (chartRef.current && chartRef.current.getDom() !== ref.current) {
        chartRef.current.dispose();
        chartRef.current = undefined;
      }
      chart = chartRef.current ?? echarts.init(ref.current, undefined, { renderer: 'svg' });
      chartRef.current = chart;
      const style = getComputedStyle(ref.current);
      const ink = style.getPropertyValue('--ink').trim();
      const muted = style.getPropertyValue('--muted').trim();
      const border = style.getPropertyValue('--line').trim();
      const surface = style.getPropertyValue('--surface').trim() || '#fff';
      const seam = { borderColor: surface, borderWidth: 2 };
      const neutral = style.getPropertyValue('--render-neutral').trim() || border;
      const axis = {
        axisLabel: { color: muted, fontSize: 10 },
        axisLine: { lineStyle: { color: border } },
        splitLine: { lineStyle: { color: border, opacity: 0.5 } },
      };
      let data: Props[] = p.points ?? p.data ?? [];
      const count =
        p.ranges?.find((r: Props) => r.id === range)?.count ??
        (p.mode === 'live' ? p.windowSize : 0);
      if (count) {
        const keys = [...new Set(data.map((d) => d.x))].slice(-count);
        data = data.filter((d) => keys.includes(d.x));
      }
      const groups = [...new Set(data.map((d) => d.series ?? '数据'))];
      const categories = [...new Set(data.map((d) => d.x))];
      let option: ECharts.EChartsOption = {
        color: colors,
        animation: !reduced,
        animationDuration: iosMotion.chart,
        animationDurationUpdate: iosMotion.chart,
        animationEasing: easeSoft,
        animationEasingUpdate: easeSoft,
        animationDelay: (index) => index * Math.min(85, 900 / Math.max(1, data.length)),
        textStyle: { fontFamily: 'inherit', color: ink },
        aria: { enabled: true },
        tooltip: { trigger: 'item', confine: true, renderMode: 'richText' },
        legend: {
          bottom: 0,
          icon: 'circle',
          itemWidth: 7,
          itemHeight: 7,
          textStyle: { color: muted, fontSize: 11 },
          type: 'scroll',
        },
        grid: { left: 40, right: 16, top: 16, bottom: 40 },
      };
      if (type === 'GaugeChart')
        option.series = [
          {
            type: 'gauge',
            min: p.min ?? 0,
            max: p.max ?? 100,
            startAngle: 225,
            endAngle: -45,
            progress: {
              show: true,
              width: 14,
              roundCap: true,
              itemStyle: {
                color: linear(colors[0], true),
                ...lift(colors[0]),
              },
            },
            axisLine: {
              roundCap: true,
              lineStyle: { width: 14, color: [[1, neutral]] },
            },
            axisTick: { show: false },
            splitLine: { show: false },
            axisLabel: { show: false },
            pointer: { show: false },
            // Value sits above centre and the caption below it, so they never overlap.
            title: { offsetCenter: [0, '34%'], color: muted, fontSize: 12 },
            detail: {
              fontSize: 32,
              color: ink,
              offsetCenter: [0, '-6%'],
              formatter: '{value}',
            },
            data: [{ value: p.value, name: p.label }],
          },
        ];
      else if (type === 'RadarChart') {
        const labels = [...new Set(data.map((d) => d.label))];
        option.radar = {
          indicator: labels.map((name) => ({ name, max: p.max ?? 100 })),
          radius: '65%',
          axisName: { color: muted },
          axisLine: { lineStyle: { color: border } },
          splitLine: { lineStyle: { color: border } },
          splitArea: {
            areaStyle: { color: ['transparent', neutral + '80'] },
          },
        };
        option.series = [
          {
            type: 'radar',
            symbol: 'circle',
            symbolSize: 6,
            data: groups.map((name, i) => ({
              name,
              itemStyle: { color: colors[i % colors.length], ...seam },
              lineStyle: {
                width: 2,
                color: colors[i % colors.length],
                ...lift(colors[i % colors.length], 8, 3),
              },
              areaStyle: {
                color: {
                  type: 'radial' as const,
                  x: 0.5,
                  y: 0.5,
                  r: 0.5,
                  colorStops: [
                    { offset: 0, color: colors[i % colors.length] + '14' },
                    { offset: 1, color: colors[i % colors.length] + '59' },
                  ],
                },
              },
              value: labels.map(
                (label) =>
                  data.find((d) => d.label === label && (d.series ?? '数据') === name)?.value ?? 0,
              ),
            })),
          },
        ];
      } else if (type === 'Heatmap') {
        const ys = [...new Set(data.map((d) => d.y))];
        option.xAxis = { type: 'category', data: categories, ...axis };
        option.yAxis = { type: 'category', data: ys, ...axis };
        option.visualMap = {
          min: 0,
          max: Math.max(1, ...data.map((d) => d.value)),
          orient: 'horizontal',
          left: 'center',
          bottom: 0,
          inRange: {
            color: [
              shade(colors[0], 0.85),
              shade(colors[0], 0.35),
              colors[0],
              shade(colors[0], -0.3),
            ],
          },
        };
        option.series = [
          {
            type: 'heatmap',
            data: data.map((d) => [categories.indexOf(d.x), ys.indexOf(d.y), d.value]),
            label: { show: true },
            itemStyle: { borderRadius: 4, ...seam },
            emphasis: { itemStyle: { shadowBlur: 12, shadowColor: '#0003' } },
          },
        ];
      } else if (type === 'FunnelChart')
        option.series = [
          {
            type: 'funnel',
            left: '12%',
            width: '76%',
            top: 10,
            bottom: 44,
            orient: p.orientation === 'horizontal' ? 'horizontal' : 'vertical',
            gap: 3,
            data: data.map((d, i) => ({
              name: d.label,
              value: d.value,
              itemStyle: {
                color: linear(colors[i % colors.length], true),
                ...lift(colors[i % colors.length]),
              },
            })),
            itemStyle: seam,
            label: {
              position: 'inside',
              formatter: p.showPercentages ? '{b}: {d}%' : '{b}: {c}',
            },
          },
        ];
      else if (type === 'SunburstChart') {
        const tree = (rows: Props[], depth = 0): any[] =>
          rows.map((d, i) => ({
            name: d.label,
            value: d.value,
            // Top-level branches carry the gradient; descendants inherit it.
            itemStyle: depth === 0 ? { color: linear(colors[i % colors.length]) } : undefined,
            children: d.children ? tree(d.children, depth + 1) : undefined,
          }));
        option.series = [
          {
            type: 'sunburst',
            data: tree(data),
            radius: ['5%', '90%'],
            label: { rotate: 'radial' },
            itemStyle: {
              borderRadius: 4,
              ...seam,
              shadowBlur: 8,
              shadowColor: '#0000001f',
            },
          },
        ];
      } else if (type === 'SankeyChart')
        option.series = [
          {
            type: 'sankey',
            data: (p.nodes ?? []).map((d: Props, i: number) => ({
              name: d.id,
              itemStyle: {
                color: linear(colors[i % colors.length]),
                ...lift(colors[i % colors.length], 8, 3),
              },
            })),
            // Node fills are gradients, so links get explicit source→target colours.
            links: (p.links ?? []).map((link: Props) => {
              const hue = (id: string) =>
                colors[
                  Math.max(
                    0,
                    (p.nodes ?? []).findIndex((d: Props) => d.id === id),
                  ) % colors.length
                ];
              return {
                ...link,
                lineStyle: {
                  color: {
                    type: 'linear' as const,
                    x: 0,
                    y: 0,
                    x2: 1,
                    y2: 0,
                    colorStops: [
                      { offset: 0, color: hue(link.source) },
                      { offset: 1, color: hue(link.target) },
                    ],
                  },
                },
              };
            }),
            emphasis: { focus: 'adjacency' },
            lineStyle: { curveness: 0.5, opacity: 0.35 },
            label: {
              color: ink,
              formatter: (v: any) => p.nodes.find((d: Props) => d.id === v.name)?.label ?? v.name,
            },
          },
        ];
      else if (type === 'RadialChart') {
        option.polar = { radius: ['15%', '80%'] };
        option.angleAxis = { max: p.max ?? 100, startAngle: 90 };
        option.radiusAxis = {
          type: 'category',
          data: data.map((d) => d.label),
          ...axis,
        };
        option.series = [
          {
            type: 'bar',
            coordinateSystem: 'polar',
            data: data.map((d, i) => ({
              value: d.value,
              itemStyle: {
                color: linear(colors[i % colors.length], true),
                ...lift(colors[i % colors.length]),
              },
            })),
            roundCap: true,
          },
        ];
      } else if (type === 'Chart' && ['pie', 'donut'].includes(p.kind))
        option.series = [
          {
            type: 'pie',
            // Sit above the bottom legend so outer labels never collide with it.
            center: ['50%', '45%'],
            radius: p.kind === 'donut' ? ['40%', '62%'] : '62%',
            data: data.map((d, i) => ({
              name: d.x,
              value: d.y,
              itemStyle: { color: linear(colors[i % colors.length]) },
            })),
            itemStyle: {
              borderRadius: p.kind === 'donut' ? 6 : 3,
              ...seam,
              shadowBlur: 14,
              shadowOffsetY: 6,
              shadowColor: '#00000024',
            },
            label: { color: ink },
            emphasis: { scale: true, scaleSize: 6 },
          },
        ];
      else {
        const horizontal = p.layout === 'horizontal';
        option.xAxis = {
          type: horizontal ? 'value' : type === 'NumericScatterChart' ? 'value' : 'category',
          data: horizontal || type === 'NumericScatterChart' ? undefined : categories,
          ...axis,
        };
        option.yAxis =
          type === 'ComposedChart'
            ? [
                { type: 'value', ...axis },
                { type: 'value', ...axis },
              ]
            : {
                type: horizontal ? 'category' : 'value',
                data: horizontal ? categories : undefined,
                ...axis,
              };
        option.tooltip = {
          trigger: type === 'NumericScatterChart' ? 'item' : 'axis',
          confine: true,
          renderMode: 'richText',
        };
        if (type === 'CandlestickChart')
          option.series = [
            {
              type: 'candlestick',
              data: data.map((d) => [d.open, d.close, d.low, d.high]),
              itemStyle: {
                color: linear(colors[1]),
                color0: linear(colors[3]),
                borderColor: shade(colors[1], -0.15),
                borderColor0: shade(colors[3], -0.15),
                ...lift(colors[1], 8, 3),
              },
            },
          ];
        else if (type === 'NumericScatterChart')
          option.series = groups.map((name) => ({
            name,
            type: 'scatter',
            data: data
              .filter((d) => (d.series ?? '数据') === name)
              .map((d) => [d.x, d.y, d.size ?? 60]),
            symbolSize: (v: number[]) => Math.max(8, Math.min(40, Math.sqrt(v[2]))),
            itemStyle: {
              color: sphere(colors[groups.indexOf(name) % colors.length]),
              ...lift(colors[groups.indexOf(name) % colors.length], 10, 4),
            },
          }));
        else
          option.series = groups.map((name, seriesIndex) => {
            const rows = data.filter((d) => (d.series ?? '数据') === name),
              kind = type === 'ComposedChart' ? rows[0]?.mark : (p.kind ?? 'line');
            const color = colors[seriesIndex % colors.length];
            return {
              name,
              id: name,
              itemStyle:
                kind === 'bar'
                  ? {
                      color: linear(color, horizontal),
                      borderRadius: p.stacked ? 3 : horizontal ? [0, 6, 6, 0] : [6, 6, 0, 0],
                      ...lift(color),
                    }
                  : kind === 'scatter'
                    ? { color: sphere(color), ...lift(color) }
                    : {
                        color,
                        borderColor: surface,
                        borderWidth: 2,
                        ...lift(color, 6, 2),
                      },
              lineStyle: {
                width: 3,
                color: {
                  type: 'linear' as const,
                  x: 0,
                  y: 0,
                  x2: 1,
                  y2: 0,
                  colorStops: [
                    { offset: 0, color: shade(color, 0.3) },
                    { offset: 1, color },
                  ],
                },
                shadowColor: color + '66',
                shadowBlur: 10,
                shadowOffsetY: 8,
              },
              symbol: 'circle',
              symbolSize: kind === 'scatter' ? 12 : 7,
              type:
                kind === 'area'
                  ? 'line'
                  : kind === 'scatter'
                    ? 'scatter'
                    : kind === 'bar'
                      ? 'bar'
                      : 'line',
              yAxisIndex: rows[0]?.axis === 'right' ? 1 : 0,
              smooth: true,
              showSymbol: data.length < 30,
              areaStyle:
                kind === 'bar' || kind === 'scatter'
                  ? undefined
                  : { color: fade(color, kind === 'area' ? 0.38 : 0.14) },
              stack: p.stacked ? 'total' : undefined,
              barMaxWidth: 36,
              data: categories.map((x) => rows.find((d) => d.x === x)?.y ?? null),
              markLine:
                p.mode === 'profit-loss'
                  ? { data: [{ yAxis: p.baseline ?? 0 }], symbol: 'none' }
                  : undefined,
            };
          });
      }
      chart.setOption(option, { replaceMerge: ['series'] });
      // ResizeObserver reports once on observe; resizing then would jump the
      // entrance animation to its end, so only react to real size changes.
      observer = new ResizeObserver(([entry]) => {
        if (
          chart &&
          (Math.round(entry.contentRect.width) !== chart.getWidth() ||
            Math.round(entry.contentRect.height) !== chart.getHeight())
        )
          chart.resize();
      });
      observer.observe(ref.current);
    });
    return () => {
      active = false;
      observer?.disconnect();
    };
  }, [type, signature, range, theme, reduced, showsTable]);
  if (type === 'GaugeChart' && p.orientation === 'linear')
    return (
      <section className="chart-frame">
        <h3>{p.title ?? p.label}</h3>
        <strong className="metric-value">{p.value}</strong>
        <progress max={(p.max ?? 100) - (p.min ?? 0)} value={p.value - (p.min ?? 0)} />
        {p.description && <p className="muted">{p.description}</p>}
      </section>
    );
  const exportRows: Props[] = p.points ?? p.data ?? p.links ?? [];
  const columns = [...new Set(exportRows.flatMap((row) => Object.keys(row)))].sort();
  return (
    <section className="chart-frame">
      <div className="chart-header">
        <h3>{p.title ?? p.label}</h3>
        <details
          className="chart-menu"
          ref={menuRef}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && menuRef.current) {
              menuRef.current.open = false;
              menuRef.current.querySelector('summary')?.focus();
            }
          }}
        >
          <summary aria-label={`${p.title ?? type}视图与导出`}>
            <Ellipsis size={16} />
          </summary>
          <div className="chart-menu-options">
            <Button
              variant="tertiary"
              onPress={() => {
                setShowsTable(!showsTable);
                if (menuRef.current) menuRef.current.open = false;
              }}
            >
              {showsTable ? '显示图表' : '显示数据表'}
            </Button>
            <Button
              variant="tertiary"
              isDisabled={!exportRows.length}
              onPress={() => {
                if (menuRef.current) menuRef.current.open = false;
                const cell = (value: unknown) =>
                  '"' + formatValue(value).replaceAll('"', '""') + '"';
                const csv = [columns, ...exportRows.map((row) => columns.map((key) => row[key]))]
                  .map((row) => row.map(cell).join(','))
                  .join('\r\n');
                const url = URL.createObjectURL(
                  new Blob(['\ufeff' + csv], {
                    type: 'text/csv;charset=utf-8',
                  }),
                );
                const link = document.createElement('a');
                link.href = url;
                link.download = (p.title ?? 'chart') + '.csv';
                link.click();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
              }}
            >
              导出 CSV
            </Button>
          </div>
        </details>
      </div>
      {p.description && <p className="muted">{p.description}</p>}
      {p.ranges && (
        <div className="row">
          {p.ranges.map((r: Props) => (
            <Button
              key={r.id}
              size="sm"
              variant={range === r.id ? 'primary' : 'tertiary'}
              onPress={() => setRange(r.id)}
            >
              {r.label}
            </Button>
          ))}
        </div>
      )}
      {p.showSummary && <strong className="metric-value">{(p.points ?? []).at(-1)?.y ?? 0}</strong>}
      {showsTable ? (
        <div className="chart-data-table">
          <table>
            <thead>
              <tr>
                {columns.map((key) => (
                  <th key={key}>{key}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {exportRows.map((row, index) => (
                <tr key={index}>
                  {columns.map((key) => (
                    <td key={key}>{formatValue(row[key])}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {!exportRows.length && <p className="muted">暂无数据</p>}
        </div>
      ) : (
        <div
          ref={ref}
          role="img"
          aria-label={p.title ?? type}
          style={{ height: 220, minWidth: 0 }}
        />
      )}
    </section>
  );
}
