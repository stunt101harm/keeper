import { RISK_BADGE } from '../domain';
import { fmtClock } from '../format';
import type { FixtureBuf } from '../store';

export function RiskLogPanel({ buf }: { buf: FixtureBuf | null }) {
  const kickoffTs = buf?.fixture?.kickoffTs ?? 0;
  const rows = buf ? [...buf.riskLog].reverse().slice(0, 20) : [];
  return (
    <div className="panel">
      <div className="panel-title">Risk log</div>
      {rows.length === 0 ? (
        <div className="empty-note">no risk transitions yet</div>
      ) : (
        <table className="table">
          <tbody>
            {rows.map((r, i) => (
              <tr key={`${r.ts}-${i}`}>
                <td className="num muted">{kickoffTs ? fmtClock(r.ts, kickoffTs) : ''}</td>
                <td className="num">
                  <span style={{ color: RISK_BADGE[r.from].color }}>{RISK_BADGE[r.from].label}</span>
                  <span className="muted"> → </span>
                  <span style={{ color: RISK_BADGE[r.to].color }}>{RISK_BADGE[r.to].label}</span>
                </td>
                <td className="ink2" style={{ whiteSpace: 'normal' }}>
                  {r.reason}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
