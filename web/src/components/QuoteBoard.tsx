import type { Outcome } from '../domain';
import { OUTCOMES, OUTCOME_COLOR, OUTCOME_LABEL } from '../domain';
import { fmtBps, fmtOdds, fmtPct } from '../format';
import type { FixtureBuf } from '../store';

function Cell({ p, side }: { p: number | null; side: 'bid' | 'ask' }) {
  if (p == null) {
    return (
      <div className={`quote-cell pulled`} title="side pulled">
        <div className="odds num">—</div>
        <div className="imp">pulled</div>
      </div>
    );
  }
  return (
    <div className={`quote-cell ${side}`}>
      <div className="odds num">{fmtOdds(p)}</div>
      <div className="imp num">{fmtPct(p)}</div>
    </div>
  );
}

export function QuoteBoard({ buf }: { buf: FixtureBuf | null }) {
  const q = buf?.latestQuotes ?? null;
  const names: Record<Outcome, string> = {
    home: buf?.fixture?.home ?? 'Home',
    draw: 'Draw',
    away: buf?.fixture?.away ?? 'Away',
  };
  return (
    <div className="panel">
      <div className="panel-title">
        Quote board
        <span className="right">decimal odds · implied %</span>
      </div>
      <div className="quote-row quote-head">
        <span />
        <span style={{ textAlign: 'center' }}>Bid (we buy)</span>
        <span style={{ textAlign: 'center' }}>Ask (we sell)</span>
        <span style={{ textAlign: 'right' }}>Spread</span>
        <span style={{ textAlign: 'right' }}>Mid</span>
      </div>
      {OUTCOMES.map((o) => {
        const quote = q?.quotes[o] ?? null;
        const bid = quote?.bid ?? null;
        const ask = quote?.ask ?? null;
        const mid = bid != null && ask != null ? (bid + ask) / 2 : (q?.fair[o] ?? null);
        return (
          <div className="quote-row" key={o}>
            <span className="outcome-chip" title={names[o]}>
              <span className="dot" style={{ background: OUTCOME_COLOR[o] }} />
              {OUTCOME_LABEL[o]}
            </span>
            <Cell p={bid} side="bid" />
            <Cell p={ask} side="ask" />
            <span className="num" style={{ textAlign: 'right', color: 'var(--ink-2)' }}>
              {fmtBps(bid, ask)}
              {bid != null && ask != null ? <span className="muted small"> bp</span> : ''}
            </span>
            <span className="num" style={{ textAlign: 'right' }}>{fmtOdds(mid)}</span>
          </div>
        );
      })}
      {!q && <div className="empty-note">no quotes published yet — engine warming up</div>}
    </div>
  );
}
