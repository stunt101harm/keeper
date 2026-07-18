/** Formatting helpers — decimal odds exist only here, at the presentation edge. */

/** Probability → decimal odds string, 2dp. Returns em-dash for pulled/invalid. */
export function fmtOdds(p: number | null | undefined): string {
  if (p == null || !isFinite(p) || p <= 0) return '—';
  return (1 / p).toFixed(2);
}

export function fmtPct(p: number | null | undefined, dp = 1): string {
  if (p == null || !isFinite(p)) return '—';
  return `${(p * 100).toFixed(dp)}%`;
}

/** Spread in basis points of probability. */
export function fmtBps(bid: number | null, ask: number | null): string {
  if (bid == null || ask == null) return '—';
  return `${Math.round((ask - bid) * 10000)}`;
}

export function fmtSigned(n: number, dp = 2): string {
  const s = n.toFixed(dp);
  return n > 0 ? `+${s}` : s;
}

/** ts → match-minute label relative to kickoff. */
export function matchMinute(ts: number, kickoffTs: number): number {
  return (ts - kickoffTs) / 60_000;
}

export function fmtMinute(min: number): string {
  if (min < 0) return `−${Math.ceil(-min)}'`;
  return `${Math.floor(min)}'`;
}

export function fmtClock(ts: number, kickoffTs: number): string {
  return fmtMinute(matchMinute(ts, kickoffTs));
}

/** Wall-clock age like "12s", "3m", "1h4m". */
export function fmtAge(nowMs: number, ts: number): string {
  const s = Math.max(0, Math.round((nowMs - ts) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${m % 60}m`;
}

export function truncHash(h: string, n = 10): string {
  return h.length <= n ? h : `${h.slice(0, n)}…`;
}

export function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour12: false });
}
