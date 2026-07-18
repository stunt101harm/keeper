import { useMemo, useRef, useState } from 'react';
import type { Outcome, Quote, RiskTransition, ScoreTick, Trade } from '../domain';
import { OUTCOMES, OUTCOME_COLOR, OUTCOME_LABEL } from '../domain';
import { fmtMinute, fmtOdds, fmtPct, matchMinute } from '../format';
import { useMeasure } from '../hooks';
import type { FixtureBuf } from '../store';

interface Pt {
  ts: number;
  fair: Record<Outcome, number>;
  quotes: Record<Outcome, Quote> | null;
}

interface ChartData {
  points: Pt[];
  goals: ScoreTick[];
  trades: Trade[];
  spans: Array<{ start: number; end: number; kind: 'frozen' | 'halted' }>;
  quotesLive: boolean;
}

const M = { top: 16, right: 74, bottom: 24, left: 44 };

function buildData(buf: FixtureBuf): ChartData {
  const points: Pt[] =
    buf.chart.length > 0
      ? buf.chart.map((q) => ({ ts: q.ts, fair: q.fair, quotes: q.quotes }))
      : buf.fairTicks.map((f) => ({ ts: f.ts, fair: f.fair, quotes: null }));
  const lastTs = points.at(-1)?.ts ?? 0;
  const spans: ChartData['spans'] = [];
  const log = buf.riskLog;
  for (let i = 0; i < log.length; i++) {
    const tr = log[i] as RiskTransition;
    if (tr.to === 'frozen' || tr.to === 'halted') {
      const end = log[i + 1]?.ts ?? lastTs;
      spans.push({ start: tr.ts, end, kind: tr.to });
    }
  }
  return { points, goals: buf.goals, trades: buf.trades, spans, quotesLive: buf.chart.length > 0 };
}

function niceTicks(min: number, max: number, n: number, steps: number[]): number[] {
  const span = max - min;
  if (!(span > 0)) return [min];
  const step = steps.find((s) => span / s <= n) ?? steps[steps.length - 1] ?? 1;
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) out.push(v);
  return out;
}

/** Binary search: index of point nearest to ts. */
function nearestIdx(points: Pt[], ts: number): number {
  let lo = 0;
  let hi = points.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((points[mid] as Pt).ts < ts) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0) {
    const a = points[lo - 1] as Pt;
    const b = points[lo] as Pt;
    if (Math.abs(a.ts - ts) <= Math.abs(b.ts - ts)) return lo - 1;
  }
  return lo;
}

export function MoneyChart({ buf, kickoffTs }: { buf: FixtureBuf; kickoffTs: number }) {
  const [wrapRef, width] = useMeasure<HTMLDivElement>();
  const height = 380;
  const [hoverX, setHoverX] = useState<number | null>(null);
  const frozenRef = useRef<ChartData | null>(null);

  const live = useMemo(
    () => buildData(buf),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [buf.chart, buf.fairTicks, buf.goals, buf.trades, buf.riskLog],
  );
  // Pause-on-hover: while the cursor is over the plot, render the snapshot taken
  // on entry so points don't slide underneath the crosshair.
  const data = hoverX != null && frozenRef.current ? frozenRef.current : live;
  const { points } = data;

  const iw = Math.max(10, width - M.left - M.right);
  const ih = height - M.top - M.bottom;

  const geom = useMemo(() => {
    if (points.length < 2) return null;
    const t0 = (points[0] as Pt).ts;
    const t1 = (points[points.length - 1] as Pt).ts;
    let lo = 1;
    let hi = 0;
    for (const p of points) {
      for (const o of OUTCOMES) {
        const f = p.fair[o];
        if (f < lo) lo = f;
        if (f > hi) hi = f;
        const q = p.quotes?.[o];
        if (q?.bid != null && q.bid < lo) lo = q.bid;
        if (q?.ask != null && q.ask > hi) hi = q.ask;
      }
    }
    for (const t of data.trades) {
      if (t.priceProb < lo) lo = t.priceProb;
      if (t.priceProb > hi) hi = t.priceProb;
    }
    const pad = Math.max(0.02, (hi - lo) * 0.12);
    const y0 = Math.max(0, lo - pad);
    const y1 = Math.min(1, hi + pad);
    const x = (ts: number) => ((ts - t0) / Math.max(1, t1 - t0)) * iw;
    const y = (p: number) => ih - ((p - y0) / Math.max(1e-9, y1 - y0)) * ih;
    return { t0, t1, y0, y1, x, y };
  }, [points, data.trades, iw, ih]);

  if (!geom) {
    return (
      <div ref={wrapRef} className="chart-wrap" style={{ height }}>
        <div className="empty-state">waiting for ticks…</div>
      </div>
    );
  }

  const { t0, t1, y0, y1, x, y } = geom;

  // --- paths -----------------------------------------------------------
  const fairPath: Record<Outcome, string> = { home: '', draw: '', away: '' };
  const bandPath: Record<Outcome, string> = { home: '', draw: '', away: '' };
  for (const o of OUTCOMES) {
    const parts: string[] = [];
    points.forEach((p, i) => {
      parts.push(`${i === 0 ? 'M' : 'L'}${x(p.ts).toFixed(1)} ${y(p.fair[o]).toFixed(1)}`);
    });
    fairPath[o] = parts.join('');

    // band: contiguous runs where both sides quoted
    let run: Pt[] = [];
    const bands: string[] = [];
    const flush = () => {
      if (run.length >= 2) {
        const top = run
          .map(
            (p, i) =>
              `${i === 0 ? 'M' : 'L'}${x(p.ts).toFixed(1)} ${y((p.quotes as Record<Outcome, Quote>)[o].ask as number).toFixed(1)}`,
          )
          .join('');
        const bottom = [...run]
          .reverse()
          .map(
            (p) =>
              `L${x(p.ts).toFixed(1)} ${y((p.quotes as Record<Outcome, Quote>)[o].bid as number).toFixed(1)}`,
          )
          .join('');
        bands.push(`${top}${bottom}Z`);
      }
      run = [];
    };
    for (const p of points) {
      const q = p.quotes?.[o];
      if (q && q.bid != null && q.ask != null) run.push(p);
      else flush();
    }
    flush();
    bandPath[o] = bands.join(' ');
  }

  const yTicks = niceTicks(y0, y1, 6, [0.01, 0.02, 0.05, 0.1, 0.2, 0.25]);
  const minSpan = (t1 - t0) / 60_000;
  const xTicks = niceTicks(matchMinute(t0, kickoffTs), matchMinute(t1, kickoffTs), 9, [
    1, 2, 5, 10, 15, 30, 45,
  ]).filter(() => minSpan > 0);

  const hoverIdx = hoverX != null ? nearestIdx(points, t0 + ((t1 - t0) * hoverX) / iw) : null;
  const hoverPt = hoverIdx != null ? (points[hoverIdx] as Pt) : null;

  const lastPt = points[points.length - 1] as Pt;

  return (
    <div ref={wrapRef} className="chart-wrap">
      <svg
        width={width || 300}
        height={height}
        style={{ display: 'block' }}
        onMouseEnter={() => {
          frozenRef.current = live;
        }}
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const px = e.clientX - rect.left - M.left;
          if (px >= 0 && px <= iw) setHoverX(px);
          else setHoverX(null);
        }}
        onMouseLeave={() => {
          frozenRef.current = null;
          setHoverX(null);
        }}
      >
        <g transform={`translate(${M.left},${M.top})`}>
          {/* grid + axes */}
          {yTicks.map((v) => (
            <g key={`y${v}`}>
              <line x1={0} x2={iw} y1={y(v)} y2={y(v)} stroke="var(--grid)" strokeWidth={1} />
              <text
                x={-8}
                y={y(v) + 3.5}
                textAnchor="end"
                fontSize={10}
                fill="var(--muted)"
                fontFamily="var(--mono)"
              >
                {Math.round(v * 100)}%
              </text>
            </g>
          ))}
          {xTicks.map((m) => {
            const ts = kickoffTs + m * 60_000;
            return (
              <g key={`x${m}`}>
                <line x1={x(ts)} x2={x(ts)} y1={ih} y2={ih + 4} stroke="var(--axis)" />
                <text
                  x={x(ts)}
                  y={ih + 15}
                  textAnchor="middle"
                  fontSize={10}
                  fill="var(--muted)"
                  fontFamily="var(--mono)"
                >
                  {fmtMinute(m)}
                </text>
              </g>
            );
          })}
          <line x1={0} x2={iw} y1={ih} y2={ih} stroke="var(--axis)" strokeWidth={1} />

          {/* freeze / halt spans */}
          {data.spans.map((s, i) => {
            const sx = Math.max(0, x(s.start));
            const ex = Math.min(iw, x(s.end));
            if (ex <= sx) return null;
            return (
              <rect
                key={`sp${i}`}
                x={sx}
                y={0}
                width={ex - sx}
                height={ih}
                fill={s.kind === 'frozen' ? 'rgba(250,178,25,0.07)' : 'rgba(208,59,59,0.08)'}
              />
            );
          })}

          {/* bid/ask bands then fair lines */}
          {OUTCOMES.map((o) => (
            <path key={`b${o}`} d={bandPath[o]} fill={OUTCOME_COLOR[o]} fillOpacity={0.16} />
          ))}
          {OUTCOMES.map((o) => (
            <path
              key={`f${o}`}
              d={fairPath[o]}
              fill="none"
              stroke={OUTCOME_COLOR[o]}
              strokeWidth={2}
              strokeLinejoin="round"
            />
          ))}

          {/* goal markers */}
          {data.goals.map((g, i) => {
            const gx = x(g.ts);
            if (gx < 0 || gx > iw) return null;
            return (
              <g key={`g${i}`}>
                <line x1={gx} x2={gx} y1={0} y2={ih} stroke="var(--ink-2)" strokeDasharray="3 3" />
                <text x={gx} y={-4} textAnchor="middle" fontSize={11} fill="var(--ink)">
                  ⚽ {g.score.home}–{g.score.away}
                </text>
              </g>
            );
          })}

          {/* fills: ▲ buy / ▼ sell, 2px surface ring via stroke */}
          {data.trades.map((t, i) => {
            const tx = x(t.ts);
            if (tx < 0 || tx > iw) return null;
            const ty = y(t.priceProb);
            const d =
              t.side === 'buy'
                ? `M${tx} ${ty - 5}L${tx + 4.5} ${ty + 3.5}L${tx - 4.5} ${ty + 3.5}Z`
                : `M${tx} ${ty + 5}L${tx + 4.5} ${ty - 3.5}L${tx - 4.5} ${ty - 3.5}Z`;
            return (
              <path
                key={`t${i}`}
                d={d}
                fill={t.side === 'buy' ? 'var(--good)' : 'var(--critical)'}
                stroke="var(--surface)"
                strokeWidth={1.5}
              />
            );
          })}

          {/* right-edge direct labels */}
          {OUTCOMES.map((o) => (
            <g key={`lab${o}`} transform={`translate(${iw + 6},${y(lastPt.fair[o])})`}>
              <rect x={0} y={-4} width={8} height={3} rx={1.5} fill={OUTCOME_COLOR[o]} />
              <text x={11} y={3} fontSize={10} fill="var(--ink-2)" fontFamily="var(--mono)">
                {OUTCOME_LABEL[o]} {fmtPct(lastPt.fair[o], 0)}
              </text>
            </g>
          ))}

          {/* crosshair */}
          {hoverPt && (
            <g>
              <line
                x1={x(hoverPt.ts)}
                x2={x(hoverPt.ts)}
                y1={0}
                y2={ih}
                stroke="var(--ink-2)"
                strokeWidth={1}
                strokeOpacity={0.5}
              />
              {OUTCOMES.map((o) => (
                <circle
                  key={`h${o}`}
                  cx={x(hoverPt.ts)}
                  cy={y(hoverPt.fair[o])}
                  r={3.5}
                  fill={OUTCOME_COLOR[o]}
                  stroke="var(--surface)"
                  strokeWidth={1.5}
                />
              ))}
            </g>
          )}
        </g>
      </svg>

      {hoverPt && (
        <div
          className="chart-tooltip"
          style={
            x(hoverPt.ts) < iw / 2
              ? { left: M.left + x(hoverPt.ts) + 14, top: 24 }
              : { left: M.left + x(hoverPt.ts) - 195, top: 24 }
          }
        >
          <div className="num" style={{ color: 'var(--ink-2)', marginBottom: 3 }}>
            {fmtMinute(matchMinute(hoverPt.ts, kickoffTs))}{' '}
            {data.quotesLive ? '· fair / bid–ask (odds)' : '· consensus fair'}
          </div>
          <table>
            <tbody>
              {OUTCOMES.map((o) => {
                const q = hoverPt.quotes?.[o];
                return (
                  <tr key={o}>
                    <td>
                      <span className="outcome-chip">
                        <span className="dot" style={{ background: OUTCOME_COLOR[o] }} />
                        {OUTCOME_LABEL[o]}
                      </span>
                    </td>
                    <td className="num">{fmtPct(hoverPt.fair[o])}</td>
                    <td className="num">{q ? `${fmtOdds(q.bid)}–${fmtOdds(q.ask)}` : ''}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {!data.quotesLive && points.length >= 2 && (
        <div
          className="small muted"
          style={{ position: 'absolute', left: M.left + 4, top: 2, pointerEvents: 'none' }}
        >
          consensus fair only — engine quotes not yet published
        </div>
      )}
    </div>
  );
}
