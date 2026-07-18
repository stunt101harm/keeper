import type { OnchainBook } from '../domain';
import { fmtAge, truncHash } from '../format';
import { useNow, useStore } from '../hooks';

const WINNER_LABEL: Record<NonNullable<OnchainBook['winner']>, string> = {
  p1: 'P1',
  draw: 'DRAW',
  p2: 'P2',
};

/** One keeper_book PDA card: root, seq coverage, epochs, status, settlement proof. */
function BookCard({ fid, book, name }: { fid: string; book: OnchainBook; name: string | null }) {
  const settleTxUrl = book.settleSig
    ? `https://explorer.solana.com/tx/${book.settleSig}?cluster=devnet`
    : null;
  return (
    <div className="book-card">
      <div className="book-card-row">
        <span className="book-card-name" title={fid}>
          {name ?? fid}
        </span>
        <span className={`status-chip ${book.status === 'settled' ? 'confirmed' : 'open'}`}>
          {book.status === 'settled' ? 'SETTLED' : 'OPEN'}
        </span>
        <a
          className="explorer small"
          style={{ marginLeft: 'auto' }}
          href={book.explorerUrl}
          target="_blank"
          rel="noreferrer"
          title={`book account ${book.address}`}
        >
          account ↗
        </a>
      </div>
      <div className="book-card-row num small ink2">
        <span title={`latest epoch root ${book.latestRoot}`}>root {truncHash(book.latestRoot, 12)}</span>
        <span>· anchored → seq {book.seqEnd}</span>
        <span>· {book.epochCount} epoch{book.epochCount === 1 ? '' : 's'}</span>
      </div>
      {book.status === 'settled' && (
        <div className="book-card-row small">
          {book.provenGoals && (
            <span className="num" title="score proven by TxLINE's on-chain stat verifier">
              proven {book.provenGoals[0]}–{book.provenGoals[1]}
            </span>
          )}
          {book.winner && <span className="ink2">· winner {WINNER_LABEL[book.winner]}</span>}
          {settleTxUrl && (
            <a
              className="explorer"
              style={{ marginLeft: 'auto' }}
              href={settleTxUrl}
              target="_blank"
              rel="noreferrer"
            >
              settle tx ↗
            </a>
          )}
        </div>
      )}
    </div>
  );
}

export function ChainPanel() {
  const store = useStore();
  const now = useNow(1000);
  const anchors = [...store.anchors].sort((a, b) => b.seqStart - a.seqStart).slice(0, 12);
  const anchoredThrough = store.anchors
    .filter((a) => a.status === 'confirmed')
    .reduce((m, a) => Math.max(m, a.seqEnd), -1);
  const proof = store.status?.proofStatus;
  const onchain = store.onchain;

  return (
    <div className="panel">
      <div className="panel-title">
        Chain anchors
        <span className="right num">
          {anchoredThrough >= 0 ? `anchored through seq ${anchoredThrough}` : 'nothing anchored yet'}
        </span>
      </div>

      {onchain && (
        <div style={{ marginBottom: 8 }}>
          <div className="book-card-row" style={{ marginBottom: 6 }}>
            <span className="small ink2">keeper_book · {onchain.network}</span>
            <a
              className="explorer small num"
              style={{ marginLeft: 'auto' }}
              href={`https://explorer.solana.com/address/${onchain.programId}?cluster=devnet`}
              target="_blank"
              rel="noreferrer"
              title={`program ${onchain.programId}`}
            >
              {truncHash(onchain.programId, 12)} ↗
            </a>
          </div>
          {Object.entries(onchain.books).map(([fid, book]) => {
            const fixture = store.fixtures.get(fid)?.fixture ?? null;
            return (
              <BookCard
                key={fid}
                fid={fid}
                book={book}
                name={fixture ? `${fixture.home} v ${fixture.away}` : null}
              />
            );
          })}
        </div>
      )}

      {proof && Object.keys(proof).length > 0 && (
        <div style={{ marginBottom: 6, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {Object.entries(proof).map(([fid, st]) => (
            <span
              key={fid}
              className={`status-chip ${st === 'verified' ? 'confirmed' : st === 'failed' ? 'failed' : 'pending'}`}
              title={`TxLINE price-proof verification for ${fid}`}
            >
              TxLINE proof: {st}
            </span>
          ))}
        </div>
      )}

      {anchors.length === 0 ? (
        <div className="empty-note">no anchor batches yet</div>
      ) : (
        anchors.map((a) => (
          <div className="anchor-row" key={`${a.seqStart}`}>
            <span className="num ink2" style={{ width: 74 }}>
              #{a.seqStart}–{a.seqEnd}
            </span>
            <span className="num muted" title={a.root}>
              {truncHash(a.root)}
            </span>
            <span className={`status-chip ${a.status}`} title={a.error ?? a.status}>
              {a.status}
            </span>
            <span className="num muted small" style={{ marginLeft: 'auto' }}>
              {fmtAge(now, a.ts)}
            </span>
            {a.explorerUrl && (
              <a className="explorer small" href={a.explorerUrl} target="_blank" rel="noreferrer">
                explorer ↗
              </a>
            )}
          </div>
        ))
      )}
    </div>
  );
}
