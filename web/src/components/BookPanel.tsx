import { useMemo } from 'react';
import { OUTCOMES, OUTCOME_COLOR, OUTCOME_LABEL, PNL_COLOR } from '../domain';
import { fmtClock, fmtOdds, fmtSigned } from '../format';
import { useMeasure } from '../hooks';
import type { BookPoint, FixtureBuf } from '../store';
import { Sparkline } from './Sparkline';

const BLOTTER_ROWS = 50;

/** Signed horizontal exposure bars around a zero axis, with ± cap markers. */
function ExposureBars({ buf, cap }: { buf: FixtureBuf; cap: number | undefined }) {
  const book = buf.book;
  const max = Math.max(
    cap ?? 0,
    ...OUTCOMES.map((o) => Math.abs(book?.netExposure[o] ?? 0)),
    1,
  );
  const W = 190;
  const half = W / 2;
  const scale = (v: number) => (v / max) * (half - 6);
  return (
    <div>
      {OUTCOMES.map((o) => {
        const v = book?.netExposure[o] ?? 0;
        const w = Math.abs(scale(v));
        const over = cap != null && Math.abs(v) >= cap;
        return (
          <div key={o} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0' }}>
            <span className="outcome-chip" style={{ width: 52 }}>
              <span className="dot" style={{ background: OUTCOME_COLOR[o] }} />
              {OUTCOME_LABEL[o]}
            </span>
            <svg width={W} height={14} style={{ display: 'block' }}>
              <line x1={half} x2={half} y1={0} y2={14} stroke="var(--axis)" />
              {cap != null && (
                <>
                  <line x1={half - scale(cap)} x2={half - scale(cap)} y1={2} y2={12} stroke="var(--serious)" strokeDasharray="2 2" strokeOpacity={0.6} />
                  <line x1={half + scale(cap)} x2={half + scale(cap)} y1={2} y2={12} stroke="var(--serious)" strokeDasharray="2 2" strokeOpacity={0.6} />
                </>
              )}
              {w > 0.5 && (
                <rect
                  x={v >= 0 ? half : half - w}
                  y={3}
                  width={w}
                  height={8}
                  rx={2}
                  fill={over ? 'var(--serious)' : OUTCOME_COLOR[o]}
                  fillOpacity={over ? 1 : 0.85}
                />
              )}
            </svg>
            <span
              className="num small"
              style={{ width: 46, textAlign: 'right', color: over ? 'var(--serious)' : 'var(--ink-2)' }}
              title={`inventory ${fmtSigned(book?.inventory[o] ?? 0, 1)} · net exposure ${fmtSigned(v, 2)}`}
            >
              {fmtSigned(v, 1)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

const PNL_SERIES = [
  { key: 'spreadCapture', label: 'spread capture' },
  { key: 'inventoryDrift', label: 'inventory drift' },
  { key: 'settlementResidual', label: 'settlement' },
] as const;

/** Three cumulative P&L decomposition series on one small chart. */
function PnlDecomposition({ history, kickoffTs }: { history: BookPoint[]; kickoffTs: number }) {
  const [ref, width] = useMeasure<HTMLDivElement>();
  const height = 110;
  const M = { top: 6, right: 8, bottom: 4, left: 34 };
  const iw = Math.max(10, width - M.left - M.right);
  const ih = height - M.top - M.bottom;

  const geom = useMemo(() => {
    if (history.length < 2) return null;
    const t0 = (history[0] as BookPoint).ts;
    const t1 = (history[history.length - 1] as BookPoint).ts;
    let lo = 0;
    let hi = 0;
    for (const p of history) {
      for (const s of PNL_SERIES) {
        const v = p[s.key];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    const pad = Math.max(0.5, (hi - lo) * 0.15);
    lo -= pad;
    hi += pad;
    const x = (ts: number) => ((ts - t0) / Math.max(1, t1 - t0)) * iw;
    const y = (v: number) => ih - ((v - lo) / (hi - lo)) * ih;
    return { x, y, lo, hi };
  }, [history, iw, ih]);

  return (
    <div ref={ref}>
      <div className="legend" style={{ marginBottom: 4 }}>
        {PNL_SERIES.map((s) => (
          <span className="item" key={s.key}>
            <span className="swatch" style={{ background: PNL_COLOR[s.key] }} />
            {s.label}
            <span className="num ink2">
              {history.length ? fmtSigned((history[history.length - 1] as BookPoint)[s.key], 2) : '—'}
            </span>
          </span>
        ))}
      </div>
      {geom ? (
        <svg width={width || 200} height={height} style={{ display: 'block' }}>
          <g transform={`translate(${M.left},${M.top})`}>
            <line x1={0} x2={iw} y1={geom.y(0)} y2={geom.y(0)} stroke="var(--axis)" strokeDasharray="2 3" />
            <text x={-6} y={geom.y(0) + 3} textAnchor="end" fontSize={9} fill="var(--muted)" fontFamily="var(--mono)">
              0
            </text>
            {PNL_SERIES.map((s) => (
              <path
                key={s.key}
                d={history
                  .map((p, i) => `${i === 0 ? 'M' : 'L'}${geom.x(p.ts).toFixed(1)} ${geom.y(p[s.key]).toFixed(1)}`)
                  .join('')}
                fill="none"
                stroke={PNL_COLOR[s.key]}
                strokeWidth={1.5}
                strokeLinejoin="round"
              />
            ))}
          </g>
        </svg>
      ) : (
        <div className="empty-note" style={{ height }}>
          decomposition appears with the first book snapshot
          {kickoffTs ? '' : ''}
        </div>
      )}
    </div>
  );
}

export function BookPanel({ buf, inventoryCap }: { buf: FixtureBuf | null; inventoryCap: number | undefined }) {
  const book = buf?.book ?? null;
  const total = book ? book.realizedPnl + book.mtmPnl : null;
  const kickoffTs = buf?.fixture?.kickoffTs ?? 0;
  const trades = buf ? [...buf.trades].reverse().slice(0, BLOTTER_ROWS) : [];

  return (
    <div className="panel">
      <div className="panel-title">
        Book &amp; P&amp;L
        {buf?.settlement && (
          <span className="right">
            settled: {OUTCOME_LABEL[buf.settlement.winner]} won{' '}
            {buf.settlement.finalScore.home}–{buf.settlement.finalScore.away}
          </span>
        )}
      </div>

      <div className="stat-row">
        <div className="stat">
          <span className="label">Total P&amp;L</span>
          <span className={`value num ${total != null && total < 0 ? 'neg' : total != null && total > 0 ? 'pos' : ''}`}>
            {total != null ? fmtSigned(total, 2) : '—'}
          </span>
        </div>
        <div className="stat">
          <span className="label">Realized</span>
          <span className="value small num">{book ? fmtSigned(book.realizedPnl, 2) : '—'}</span>
        </div>
        <div className="stat">
          <span className="label">MTM</span>
          <span className="value small num">{book ? fmtSigned(book.mtmPnl, 2) : '—'}</span>
        </div>
        <div className="stat">
          <span className="label">Trades</span>
          <span className="value small num">{book?.tradeCount ?? 0}</span>
        </div>
        <div className="stat" style={{ marginLeft: 'auto' }}>
          <span className="label">P&amp;L trend</span>
          <Sparkline
            values={(buf?.bookHistory ?? []).map((p) => p.total)}
            width={140}
            height={32}
            color={total != null && total < 0 ? 'var(--critical)' : 'var(--good)'}
          />
        </div>
      </div>

      <div className="book-grid">
        <div>
          <div className="panel-title" style={{ marginBottom: 4 }}>
            Net exposure <span className="hint">±cap {inventoryCap ?? '—'}</span>
          </div>
          {buf && (buf.book || true) ? (
            <ExposureBars buf={buf} cap={inventoryCap} />
          ) : null}
        </div>
        <div style={{ minWidth: 0 }}>
          <div className="panel-title" style={{ marginBottom: 4 }}>
            P&amp;L decomposition <span className="hint">cumulative</span>
          </div>
          <PnlDecomposition history={buf?.bookHistory ?? []} kickoffTs={kickoffTs} />
        </div>
      </div>

      <div className="panel-title" style={{ margin: '10px 0 4px' }}>
        Trade blotter <span className="hint">newest first · last {BLOTTER_ROWS}</span>
      </div>
      {trades.length === 0 ? (
        <div className="empty-note">no fills yet</div>
      ) : (
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Outcome</th>
                <th>Side</th>
                <th>Type</th>
                <th className="r">Price</th>
                <th className="r">Mid@fill</th>
                <th className="r">Size</th>
              </tr>
            </thead>
            <tbody>
              {trades.map((t) => (
                <tr key={t.tradeId}>
                  <td className="num">{kickoffTs ? fmtClock(t.ts, kickoffTs) : ''}</td>
                  <td>
                    <span className="outcome-chip">
                      <span className="dot" style={{ background: OUTCOME_COLOR[t.outcome] }} />
                      {OUTCOME_LABEL[t.outcome]}
                    </span>
                  </td>
                  <td className={t.side === 'buy' ? 'side-buy' : 'side-sell'}>
                    {t.side === 'buy' ? '▲ BUY' : '▼ SELL'}
                  </td>
                  <td>
                    <span className={`fill-chip ${t.fillType}`}>{t.fillType}</span>
                  </td>
                  <td className="r num">{fmtOdds(t.priceProb)}</td>
                  <td className="r num">{fmtOdds(t.midAtFill)}</td>
                  <td className="r num">{t.size}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
