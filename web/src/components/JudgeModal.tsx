import { useEffect } from 'react';

/** Judge-orientation modal: what Keeper is, in six tight bullets. */
export function JudgeModal({ onClose, live }: { onClose: () => void; live: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          What am I looking at?
          <button className="modal-close" onClick={onClose} aria-label="close">
            ×
          </button>
        </div>
        <ul className="modal-list">
          <li>
            <b>Keeper is an autonomous market maker.</b> It prices World Cup 1X2 markets off
            TxLINE&apos;s consensus odds feed and quotes both sides of all three outcomes, all
            match long. No human in the loop.
          </li>
          <li>
            <b>The band is our quotes.</b> Line = de-vigged consensus fair value, shaded band =
            our live bid–ask, ▲▼ = fills against us, shaded spans = event freezes (goal / VAR /
            red card).
          </li>
          <li>
            <b>The engine is deterministic.</b> A pure reducer over ticks — no wall clock, no
            RNG. Same tick stream ⇒ identical book, byte for byte.
          </li>
          <li>
            <b>Every event lands on-chain.</b> Engine output is merkle-anchored to Solana devnet
            in sequence-continuous batches — click any &ldquo;explorer ↗&rdquo; link and check.
          </li>
          <li>
            <b>Settlement is proof-gated.</b> The on-chain book can only settle against a score
            proven by TxLINE&apos;s own on-chain verifier — Keeper cannot grade its own homework.
          </li>
          <li>
            {live ? (
              <>
                <b>This is live.</b> Real TxLINE World Cup data, in play right now.
              </>
            ) : (
              <>
                <b>This is a replay.</b> Real recorded TxLINE World Cup data, replayed at speed.
                Everything you see — quoting, fills, anchoring — runs exactly as it does live.
              </>
            )}
          </li>
        </ul>
      </div>
    </div>
  );
}
