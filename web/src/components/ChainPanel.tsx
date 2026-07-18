import { fmtAge, truncHash } from '../format';
import { useNow, useStore } from '../hooks';

export function ChainPanel() {
  const store = useStore();
  const now = useNow(1000);
  const anchors = [...store.anchors].sort((a, b) => b.seqStart - a.seqStart).slice(0, 12);
  const anchoredThrough = store.anchors
    .filter((a) => a.status === 'confirmed')
    .reduce((m, a) => Math.max(m, a.seqEnd), -1);
  const proof = store.status?.proofStatus;

  return (
    <div className="panel">
      <div className="panel-title">
        Chain anchors
        <span className="right num">
          {anchoredThrough >= 0 ? `anchored through seq ${anchoredThrough}` : 'nothing anchored yet'}
        </span>
      </div>

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
