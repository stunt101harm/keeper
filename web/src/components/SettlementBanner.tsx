import type { Outcome } from '../domain';
import { OUTCOME_LABEL, PNL_COLOR } from '../domain';
import { fmtSigned } from '../format';
import { useStore } from '../hooks';
import type { FixtureBuf } from '../store';

interface SettleView {
  winner: Outcome;
  score: { home: number; away: number };
  realizedPnl: number | null;
}

/**
 * Derive what to show: prefer the SettlementEvent; fall back to book state
 * (riskState 'settled' + final score) for clients that hydrated after the
 * event fired. Returns null when the fixture is not settled.
 */
function settleView(buf: FixtureBuf): SettleView | null {
  if (buf.settlement) {
    return {
      winner: buf.settlement.winner,
      score: buf.settlement.finalScore,
      realizedPnl: buf.settlement.realizedPnl,
    };
  }
  const riskState = buf.latestQuotes?.riskState ?? buf.riskLog.at(-1)?.to;
  const score = buf.latestScore?.score;
  if (riskState !== 'settled' || !score) return null;
  return {
    winner: score.home > score.away ? 'home' : score.home < score.away ? 'away' : 'draw',
    score,
    realizedPnl: buf.book ? buf.book.realizedPnl : null,
  };
}

/**
 * Prominent strip shown once the selected fixture settles. Disappears
 * automatically when the replay loop restarts (the loop-reset path replaces
 * the fixture buffer, clearing settlement + book state).
 */
export function SettlementBanner({ buf }: { buf: FixtureBuf | null }) {
  const store = useStore();
  if (!buf) return null;
  const view = settleView(buf);
  if (!view) return null;

  const fixture = buf.fixture;
  const winnerLabel =
    view.winner === 'draw'
      ? 'DRAW'
      : fixture
        ? `${view.winner === 'home' ? fixture.home : fixture.away} WIN`
        : `${OUTCOME_LABEL[view.winner]} WIN`;
  const pnl = view.realizedPnl;
  const decomp = buf.book?.pnl ?? null;

  const chainBook = store.onchain?.books[buf.id];
  const chainSettled = chainBook?.status === 'settled';
  const settleTxUrl = chainBook?.settleSig
    ? `https://explorer.solana.com/tx/${chainBook.settleSig}?cluster=devnet`
    : null;

  return (
    <div className="settle-banner">
      <span className="settle-flag num">FT {view.score.home}–{view.score.away}</span>
      <span className="settle-main">
        {fixture ? `${fixture.home} v ${fixture.away} — ` : ''}
        <b>{winnerLabel}</b> · book settled
      </span>
      {pnl != null && (
        <span className="settle-pnl num" title="realized P&L at settlement (stake units)">
          P&amp;L{' '}
          <b className={pnl < 0 ? 'neg' : pnl > 0 ? 'pos' : ''}>{fmtSigned(pnl, 2)}</b>
        </span>
      )}
      {decomp && (
        <span className="settle-decomp num small">
          <span style={{ color: PNL_COLOR.spreadCapture }}>
            spread {fmtSigned(decomp.spreadCapture, 2)}
          </span>
          <span style={{ color: PNL_COLOR.inventoryDrift }}>
            drift {fmtSigned(decomp.inventoryDrift, 2)}
          </span>
          <span style={{ color: PNL_COLOR.settlementResidual }}>
            residual {fmtSigned(decomp.settlementResidual, 2)}
          </span>
        </span>
      )}
      {chainSettled && (
        <span className="settle-chain">
          ✓ settled on-chain against TxLINE&apos;s proven score
          {settleTxUrl && (
            <a className="explorer" href={settleTxUrl} target="_blank" rel="noreferrer">
              settle tx ↗
            </a>
          )}
        </span>
      )}
    </div>
  );
}
