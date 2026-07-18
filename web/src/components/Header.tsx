import { useEffect, useState } from 'react';
import type { RiskStateName } from '../domain';
import { RISK_BADGE } from '../domain';
import { fmtClock } from '../format';
import { useNow, useStore } from '../hooks';
import type { FixtureBuf } from '../store';

function feedState(
  conn: string,
  statusFeed: 'ok' | 'stale' | 'disconnected' | undefined,
  lastEventAt: number,
  now: number,
): 'ok' | 'stale' | 'disconnected' {
  if (conn !== 'open') return 'disconnected';
  if (lastEventAt > 0 && now - lastEventAt > 20_000) return 'stale';
  return statusFeed ?? 'ok';
}

export function Header({ buf }: { buf: FixtureBuf | null }) {
  const store = useStore();
  const now = useNow(1000);
  const [confirmHalt, setConfirmHalt] = useState(false);

  useEffect(() => {
    if (!confirmHalt) return;
    const id = setTimeout(() => setConfirmHalt(false), 3000);
    return () => clearTimeout(id);
  }, [confirmHalt]);

  const fixture = buf?.fixture ?? null;
  const score = buf?.latestScore ?? null;
  const riskState: RiskStateName = store.halted
    ? 'halted'
    : (buf?.latestQuotes?.riskState ?? buf?.riskLog.at(-1)?.to ?? 'idle');
  const risk = RISK_BADGE[riskState];
  const riskReason = buf?.riskLog.at(-1)?.reason;

  const feed = feedState(store.conn, store.status?.feed, store.lastEventAt, now);

  let clock = '';
  if (score?.event === 'fulltime') clock = 'FT';
  else if (score?.event === 'halftime') clock = 'HT';
  else if (fixture) {
    const ts = buf?.lastTs ?? 0;
    if (score?.minute != null) clock = `${score.minute}'`;
    else if (ts > 0) clock = fmtClock(ts, fixture.kickoffTs);
  }

  const onHalt = () => {
    if (store.halted) {
      void store.setHalted(false);
      return;
    }
    if (!confirmHalt) {
      setConfirmHalt(true);
      return;
    }
    setConfirmHalt(false);
    void store.setHalted(true);
  };

  return (
    <header className="header">
      <div className="brand">
        KEEPER<span>▮</span>
      </div>
      {fixture ? (
        <div className="fixture-title">
          <span className="teams">{fixture.home}</span>
          <span className="score num">
            {score ? `${score.score.home}–${score.score.away}` : 'v'}
          </span>
          <span className="teams">{fixture.away}</span>
          {clock && <span className="clock num">{clock}</span>}
          <span className="competition">{fixture.competition}</span>
        </div>
      ) : (
        <div className="fixture-title">
          <span className="teams muted">awaiting fixture…</span>
        </div>
      )}
      <div className="header-right">
        <span
          className="badge"
          style={{
            color: store.mode === 'live' ? 'var(--critical)' : 'var(--ink-2)',
            background:
              store.mode === 'live' ? 'rgba(208,59,59,0.14)' : 'rgba(154,164,178,0.10)',
          }}
        >
          {store.mode === 'live' ? '● LIVE' : `REPLAY ×${store.replay?.speed ?? 1}`}
        </span>
        <span
          className="badge"
          title={`feed: ${feed}${store.conn !== 'open' ? ' (SSE reconnecting)' : ''}`}
          style={{ color: 'var(--ink-2)', background: 'rgba(154,164,178,0.10)' }}
        >
          <span className={`dot ${feed}`} /> FEED
        </span>
        <span
          className="badge"
          title={riskReason ? `last transition: ${riskReason}` : 'no risk transitions yet'}
          style={{ color: risk.color, background: risk.bg, borderColor: `${risk.color}44` }}
        >
          {risk.label}
        </span>
        <button
          className={`halt-btn ${store.halted ? 'resume' : ''} ${confirmHalt ? 'confirm' : ''}`}
          onClick={onHalt}
          title={
            store.halted
              ? 'resume quoting'
              : 'kill switch: pull all quotes (click twice to confirm)'
          }
        >
          {store.halted ? 'RESUME' : confirmHalt ? 'CONFIRM HALT?' : 'HALT'}
        </button>
      </div>
    </header>
  );
}
