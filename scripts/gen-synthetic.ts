/**
 * Generates a deterministic synthetic in-play match recording so the engine,
 * tests, and dashboard can run before any real TxLINE recording exists.
 * Seeded PRNG — same seed ⇒ byte-identical output.
 *
 *   tsx scripts/gen-synthetic.ts [outfile] [seed]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { FixtureInfo, MatchEventType, Outcome, Tick } from '../src/types.js';

const outFile = process.argv[2] ?? 'data/sample-match.jsonl';
const seed = Number(process.argv[3] ?? 42);

// mulberry32 — tiny deterministic PRNG
function mulberry32(a: number) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(seed);
const gauss = () => {
  // Box-Muller with deterministic source
  const u = Math.max(rand(), 1e-9);
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};

const logit = (p: number) => Math.log(p / (1 - p));
const invLogit = (x: number) => 1 / (1 + Math.exp(-x));

const KICKOFF = Date.parse('2026-07-14T19:00:00Z');
const fixture: FixtureInfo = {
  id: 'synthetic-1',
  home: 'Synthetica FC',
  away: 'Determinism United',
  kickoffTs: KICKOFF,
  competition: 'Synthetic Friendly',
};

// True latent win probabilities (home, draw, away)
let p: Record<Outcome, number> = { home: 0.42, draw: 0.28, away: 0.3 };
let score = { home: 0, away: 0 };

// Scripted match beats (deterministic given seed): goals + a VAR check
const goalMinutes: Array<{ minute: number; team: 'home' | 'away' }> = [
  { minute: 23, team: 'home' },
  { minute: 57, team: 'away' },
  { minute: 78, team: 'home' },
];
const varMinute = 64; // VAR check, no goal

const lines: string[] = [JSON.stringify({ kind: 'meta', fixture })];
const push = (tick: Tick) => lines.push(JSON.stringify(tick));

function normalize(q: Record<Outcome, number>): Record<Outcome, number> {
  const s = q.home + q.draw + q.away;
  return { home: q.home / s, draw: q.draw / s, away: q.away / s };
}

/** Publish consensus odds with ~6% multiplicative overround. */
function oddsTick(ts: number, suspended = false): void {
  const over = 1.06;
  push({
    kind: 'odds',
    fixtureId: fixture.id,
    ts,
    odds: {
      home: round(1 / (p.home * over)),
      draw: round(1 / (p.draw * over)),
      away: round(1 / (p.away * over)),
    },
    ...(suspended ? { suspended: true } : {}),
  });
}
const round = (x: number) => Math.round(x * 100) / 100;

function scoreTick(ts: number, event: MatchEventType, minute?: number): void {
  push({
    kind: 'score',
    fixtureId: fixture.id,
    ts,
    score: { ...score },
    ...(minute !== undefined ? { minute } : {}),
    event,
  });
}

/** Random-walk step in logit space + late-game pull toward the current leader. */
function drift(minute: number): void {
  const vol = 0.015 + (minute > 80 ? 0.01 : 0);
  const l: Record<Outcome, number> = {
    home: logit(p.home) + gauss() * vol,
    draw: logit(p.draw) + gauss() * vol,
    away: logit(p.away) + gauss() * vol,
  };
  let q: Record<Outcome, number> = {
    home: invLogit(l.home),
    draw: invLogit(l.draw),
    away: invLogit(l.away),
  };
  // Convergence: as time runs out, the on-field result absorbs probability.
  const leadOutcome: Outcome =
    score.home > score.away ? 'home' : score.away > score.home ? 'away' : 'draw';
  const pull = Math.max(0, (minute - 60) / 30) * 0.03;
  q[leadOutcome] += pull;
  p = normalize(q);
}

function goalJump(team: 'home' | 'away', minute: number): void {
  const jump = 0.14 + 0.1 * (minute / 90); // late goals move markets more
  const q = { ...p };
  q[team] += jump;
  q[team === 'home' ? 'away' : 'home'] *= 0.65;
  p = normalize(q);
}

// ---- Pre-match: 10 minutes of slow ticks -----------------------------------
for (let s = -600; s < 0; s += 15) {
  drift(0);
  oddsTick(KICKOFF + s * 1000);
}
scoreTick(KICKOFF, 'kickoff', 0);

// ---- Match loop: one odds tick every ~5s of match time ---------------------
const HALF_BREAK = 15 * 60 * 1000;
let goalIdx = 0;
for (let sec = 0; sec <= 94 * 60; sec += 5) {
  const minute = sec / 60;
  const wallTs = KICKOFF + sec * 1000 + (minute > 45 ? HALF_BREAK : 0);

  const goal = goalIdx < goalMinutes.length ? goalMinutes[goalIdx] : undefined;
  if (goal && minute >= goal.minute) {
    goalIdx++;
    score = {
      home: score.home + (goal.team === 'home' ? 1 : 0),
      away: score.away + (goal.team === 'away' ? 1 : 0),
    };
    scoreTick(wallTs, 'goal', Math.floor(minute));
    oddsTick(wallTs + 500, true); // books suspend
    goalJump(goal.team, minute);
    // market comes back ~40s later, repriced
    oddsTick(wallTs + 40_000);
    sec += 40; // skip ahead past the suspension
    continue;
  }
  if (Math.floor(minute) === varMinute && sec % 60 === 0) {
    scoreTick(wallTs, 'var', varMinute);
    oddsTick(wallTs + 500, true);
    oddsTick(wallTs + 70_000); // VAR resolved, no change
    sec += 70;
    continue;
  }
  if (Math.floor(minute) === 45 && sec % 60 === 0) scoreTick(wallTs, 'halftime', 45);
  if (Math.floor(minute) === 46 && sec % 60 === 5) scoreTick(wallTs, 'second_half', 46);

  drift(minute);
  // jittered cadence: skip some ticks to mimic uneven update flow
  if (rand() < 0.85) oddsTick(wallTs + Math.floor(rand() * 900));
}

// ---- Full time --------------------------------------------------------------
const endTs = KICKOFF + 94 * 60 * 1000 + HALF_BREAK + 60_000;
scoreTick(endTs, 'fulltime', 94);

mkdirSync(path.dirname(outFile), { recursive: true });
writeFileSync(outFile, lines.join('\n') + '\n');
console.log(`wrote ${lines.length - 1} ticks to ${outFile} (final score ${score.home}-${score.away})`);
