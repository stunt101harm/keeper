import { describe, expect, it } from 'vitest';
import { fmtBps, fmtClock, fmtMinute, fmtOdds, fmtPct, fmtSigned, truncHash } from './format';

describe('fmtOdds', () => {
  it('converts probability to 2dp decimal odds', () => {
    expect(fmtOdds(0.5)).toBe('2.00');
    expect(fmtOdds(0.4)).toBe('2.50');
  });

  it('renders pulled/invalid sides as em-dash', () => {
    expect(fmtOdds(null)).toBe('—');
    expect(fmtOdds(0)).toBe('—');
    expect(fmtOdds(undefined)).toBe('—');
  });
});

describe('fmtPct', () => {
  it('formats probability as percent', () => {
    expect(fmtPct(0.415)).toBe('41.5%');
    expect(fmtPct(null)).toBe('—');
  });
});

describe('fmtBps', () => {
  it('reports spread in probability basis points', () => {
    expect(fmtBps(0.4, 0.42)).toBe('200');
    expect(fmtBps(null, 0.42)).toBe('—');
  });
});

describe('match clock', () => {
  it('formats minutes relative to kickoff', () => {
    const k = 1_000_000_000;
    expect(fmtClock(k + 64 * 60_000, k)).toBe("64'");
    expect(fmtClock(k - 6 * 60_000, k)).toBe("−6'");
    expect(fmtMinute(90.9)).toBe("90'");
  });
});

describe('misc', () => {
  it('signs numbers explicitly', () => {
    expect(fmtSigned(1.5)).toBe('+1.50');
    expect(fmtSigned(-1.5)).toBe('-1.50');
  });

  it('truncates hashes', () => {
    expect(truncHash('abcdef0123456789')).toBe('abcdef0123…');
    expect(truncHash('short')).toBe('short');
  });
});
