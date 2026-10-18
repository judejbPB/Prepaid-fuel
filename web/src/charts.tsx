import { useEffect, useRef, useState, type ReactNode } from 'react';
import { t } from './i18n';

// Small hand-drawn charts for the dashboards. Colors come from the --viz-* tokens in styles.css (validated
// categorical slots); text always uses the text tokens. Every chart sits in a ChartCard that can switch to a
// table, so no value is only reachable by hovering.

/** Width of an element, kept up to date. */
function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(600);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(240, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { ref, width };
}

/** Clean axis ticks from 0 to just above max. */
function niceTicks(max: number, count = 4) {
  if (max <= 0) return [0, 1];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw)!;
  const ticks: number[] = [];
  for (let v = 0; v <= max + step * 0.001; v += step) ticks.push(v);
  if (ticks[ticks.length - 1] < max) ticks.push(ticks[ticks.length - 1] + step);
  return ticks;
}

/** 1 234 567 → "1,2 M"; 12 900 → "12,9 k" (locale-aware). */
export function compact(n: number, locale: string) {
  return new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(n);
}

/** Card with a title, an optional subtitle and a chart/table switch. */
export function ChartCard({ title, sub, chart, table, busy }: { title: string; sub?: string; chart: ReactNode; table: ReactNode; busy?: boolean }) {
  const [asTable, setAsTable] = useState(false);
  return (
    <div className="card white chart-card" style={{ opacity: busy ? 0.55 : 1 }}>
      <div className="row between" style={{ alignItems: 'flex-start' }}>
        <div>
          <h2 style={{ marginBottom: 2 }}>{title}</h2>
          {sub && <div className="small muted">{sub}</div>}
        </div>
        <button className="sm ghost" onClick={() => setAsTable(!asTable)} aria-pressed={asTable}>{asTable ? t('Chart') : t('Table')}</button>
      </div>
      <div className="mt">{asTable ? <div className="table-wrap">{table}</div> : chart}</div>
    </div>
  );
}

export interface Point { label: string; value: number; lines: string[] }

/** One series over time: 2px line, light wash, end dot and end label, crosshair with a tooltip. */
export function LineChart({ points, format, axisFormat, height = 220 }: {
  points: Point[]; format: (v: number) => string; axisFormat: (v: number) => string; height?: number;
}) {
  const { ref, width } = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const pad = { top: 12, right: 92, bottom: 28, left: 52 };
  const w = width - pad.left - pad.right;
  const h = height - pad.top - pad.bottom;
  const ticks = niceTicks(Math.max(0, ...points.map((p) => p.value)));
  const top = ticks[ticks.length - 1] || 1;
  const x = (i: number) => pad.left + (points.length <= 1 ? w / 2 : (i / (points.length - 1)) * w);
  const y = (v: number) => pad.top + h - (v / top) * h;
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join('');
  const area = points.length ? `${path}L${x(points.length - 1).toFixed(1)},${y(0)}L${x(0).toFixed(1)},${y(0)}Z` : '';
  const last = points.length - 1;
  const xLabels = points.length <= 1 ? [0] : [0, Math.floor(last / 2), last];

  const nearest = (clientX: number, rect: DOMRect) => {
    if (!points.length) return null;
    const rel = clientX - rect.left - pad.left;
    return Math.max(0, Math.min(last, Math.round((rel / Math.max(1, w)) * last)));
  };
  const tip = hover != null ? points[hover] : null;
  return (
    <div ref={ref} className="viz" style={{ position: 'relative' }}>
      <svg width={width} height={height} role="img" aria-label={t('Line chart')} tabIndex={0}
        onPointerMove={(e) => setHover(nearest(e.clientX, e.currentTarget.getBoundingClientRect()))}
        onPointerLeave={() => setHover(null)}
        onFocus={() => setHover(last)} onBlur={() => setHover(null)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft') setHover((hover ?? last) > 0 ? (hover ?? last) - 1 : 0);
          if (e.key === 'ArrowRight') setHover(Math.min(last, (hover ?? -1) + 1));
        }}>
        {ticks.map((v) => (
          <g key={v}>
            <line x1={pad.left} x2={pad.left + w} y1={y(v)} y2={y(v)} className="viz-grid" />
            <text x={pad.left - 8} y={y(v)} dy="0.32em" textAnchor="end" className="viz-tick">{axisFormat(v)}</text>
          </g>
        ))}
        {xLabels.map((i) => (
          <text key={i} x={x(i)} y={height - 8} textAnchor={i === 0 && points.length > 1 ? 'start' : i === last && points.length > 1 ? 'end' : 'middle'} className="viz-tick">{points[i]?.label}</text>
        ))}
        <path d={area} className="viz-area" />
        <path d={path} className="viz-line" />
        {hover != null && <line x1={x(hover)} x2={x(hover)} y1={pad.top} y2={pad.top + h} className="viz-cross" />}
        {points.length > 0 && (
          <>
            <circle cx={x(hover ?? last)} cy={y(points[hover ?? last].value)} r={4} className="viz-dot" />
            {hover == null && <text x={x(last) + 8} y={y(points[last].value)} dy="0.32em" className="viz-endlabel">{format(points[last].value)}</text>}
          </>
        )}
      </svg>
      {tip && (
        <div className="viz-tip" style={{ left: Math.min(width - 180, Math.max(0, x(hover!) + 10)), top: 8 }}>
          <strong>{format(tip.value)}</strong>
          <div className="muted">{tip.label}</div>
          {tip.lines.map((l) => <div key={l} className="muted">{l}</div>)}
        </div>
      )}
    </div>
  );
}

export interface BarRow { name: string; value: number; lines: string[] }

/** One series, compared across items: horizontal bars from one baseline, value at the tip, hover tooltip. */
export function HBars({ rows, format, empty }: { rows: BarRow[]; format: (v: number) => string; empty: string }) {
  const max = Math.max(0, ...rows.map((r) => r.value));
  const [hover, setHover] = useState<number | null>(null);
  if (!rows.length || max === 0) return <p className="small muted">{empty}</p>;
  return (
    <div className="viz-bars">
      {rows.map((r, i) => (
        <div key={r.name} className="viz-bar-row" tabIndex={0} onPointerEnter={() => setHover(i)} onPointerLeave={() => setHover(null)}
          onFocus={() => setHover(i)} onBlur={() => setHover(null)}>
          <div className="viz-bar-name" title={r.name}>{r.name}</div>
          <div className="viz-bar-track">
            <div className={`viz-bar${hover === i ? ' on' : ''}`} style={{ width: `${Math.max(1, (r.value / max) * 100)}%` }} />
            <span className="viz-bar-value">{format(r.value)}</span>
            {hover === i && r.lines.length > 0 && (
              <div className="viz-tip" style={{ left: 0, top: 26 }}>
                <strong>{format(r.value)}</strong><div className="muted">{r.name}</div>
                {r.lines.map((l) => <div key={l} className="muted">{l}</div>)}
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Part-to-whole in one bar: segments separated by a 2px surface gap, with a legend carrying the values. */
export function SplitBar({ parts, format, empty }: { parts: { name: string; value: number; slot: 1 | 2 }[]; format: (v: number) => string; empty: string }) {
  const total = parts.reduce((s, p) => s + p.value, 0);
  if (!total) return <p className="small muted">{empty}</p>;
  return (
    <div>
      <div className="viz-split" role="img" aria-label={parts.map((p) => `${p.name} ${Math.round((p.value / total) * 100)}%`).join(', ')}>
        {parts.filter((p) => p.value > 0).map((p) => (
          <div key={p.name} className={`viz-seg viz-slot-${p.slot}`} style={{ flexGrow: p.value }} title={`${p.name}: ${format(p.value)}`} />
        ))}
      </div>
      <div className="viz-legend mt">
        {parts.map((p) => (
          <div key={p.name} className="row" style={{ gap: 8 }}>
            <span className={`viz-swatch viz-slot-${p.slot}`} />
            <span>{p.name}</span>
            <strong>{Math.round((p.value / total) * 100)} %</strong>
            <span className="muted">{format(p.value)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Headline figure with its change against the previous period (arrow + sign + words, never color alone). */
export function StatTile({ label, value, now, prev, upIsGood = true, note, vs, pct: given }: {
  label: string; value: string; now?: number; prev?: number; upIsGood?: boolean; note?: string; vs?: string;
  /** A change already worked out (e.g. like for like); shown instead of comparing now with prev. */
  pct?: number | null;
}) {
  let delta: ReactNode = null;
  if (given != null) delta = <Delta pct={given} upIsGood={upIsGood} vs={vs} />;
  else if (now != null && prev != null) {
    if (prev === 0 && now === 0) delta = <span className="muted">{t('No change')}</span>;
    else if (prev === 0) delta = <span className="muted">{t('New this period')}</span>;
    else {
      delta = <Delta pct={Math.round(((now - prev) / prev) * 100)} upIsGood={upIsGood} vs={vs} />;
    }
  }
  return (
    <div className="kpi card white">
      <div className="label">{label}</div>
      <div className="value" style={{ fontVariantNumeric: 'normal', fontSize: 26, whiteSpace: 'nowrap' }}>{value}</div>
      <div className="sub">{delta ?? note}</div>
    </div>
  );
}

export interface PairPoint { label: string; a: number; b: number }

/** Two series side by side per period (e.g. given vs used each month): columns from one baseline, a legend, a tooltip. */
export function PairedColumns({ points, names, format, axisFormat, height = 220 }: {
  points: PairPoint[]; names: [string, string]; format: (v: number) => string; axisFormat: (v: number) => string; height?: number;
}) {
  const { ref, width } = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const pad = { top: 12, right: 8, bottom: 28, left: 52 };
  const w = width - pad.left - pad.right;
  const h = height - pad.top - pad.bottom;
  const ticks = niceTicks(Math.max(0, ...points.flatMap((p) => [p.a, p.b])));
  const topV = ticks[ticks.length - 1] || 1;
  const y = (v: number) => pad.top + h - (v / topV) * h;
  const band = w / Math.max(1, points.length);
  const col = Math.max(3, Math.min(28, (band - 10) / 2));
  const labelEvery = Math.max(1, Math.ceil(40 / band)); // keep axis labels from running into each other on phones
  const tip = hover != null ? points[hover] : null;
  return (
    <div ref={ref} className="viz" style={{ position: 'relative' }}>
      <div className="viz-legend" style={{ flexDirection: 'row', gap: 16, marginBottom: 6 }}>
        {names.map((n, i) => <span key={n} className="row" style={{ gap: 6 }}><span className={`viz-swatch viz-slot-${i + 1}`} />{n}</span>)}
      </div>
      <svg width={width} height={height} role="img" aria-label={names.join(' / ')} onPointerLeave={() => setHover(null)}>
        {ticks.map((v) => (
          <g key={v}>
            <line x1={pad.left} x2={pad.left + w} y1={y(v)} y2={y(v)} className="viz-grid" />
            <text x={pad.left - 8} y={y(v)} dy="0.32em" textAnchor="end" className="viz-tick">{axisFormat(v)}</text>
          </g>
        ))}
        {points.map((p, i) => {
          const cx = pad.left + band * i + band / 2;
          return (
            <g key={p.label} tabIndex={0} onPointerEnter={() => setHover(i)} onFocus={() => setHover(i)} onBlur={() => setHover(null)} style={{ outline: 'none' }}>
              <rect x={pad.left + band * i} y={pad.top} width={band} height={h} fill="transparent" />
              <rect x={cx - col - 1} y={y(p.a)} width={col} height={Math.max(0, y(0) - y(p.a))} rx={2} className="viz-slot-1" style={{ fill: 'var(--viz-1)', opacity: hover == null || hover === i ? 1 : 0.6 }} />
              <rect x={cx + 1} y={y(p.b)} width={col} height={Math.max(0, y(0) - y(p.b))} rx={2} style={{ fill: 'var(--viz-2)', opacity: hover == null || hover === i ? 1 : 0.6 }} />
              {i % labelEvery === 0 && <text x={cx} y={height - 8} textAnchor="middle" className="viz-tick">{p.label}</text>}
            </g>
          );
        })}
      </svg>
      {tip && (
        <div className="viz-tip" style={{ left: Math.min(width - 190, Math.max(0, pad.left + band * hover! + band / 2 + 10)), top: 30 }}>
          <strong>{tip.label}</strong>
          <div><span className="viz-swatch viz-slot-1" /> {names[0]} : {format(tip.a)}</div>
          <div><span className="viz-swatch viz-slot-2" /> {names[1]} : {format(tip.b)}</div>
        </div>
      )}
    </div>
  );
}

function Delta({ pct, upIsGood, vs }: { pct: number; upIsGood: boolean; vs?: string }) {
  const good = pct === 0 ? null : (pct > 0) === upIsGood;
  return (
    <span className={good == null ? 'muted' : good ? 'delta-good' : 'delta-bad'}>
      {pct > 0 ? '▲' : pct < 0 ? '▼' : '='} {pct > 0 ? '+' : ''}{pct} % <span className="muted">{vs ?? t('vs previous period')}</span>
    </span>
  );
}
