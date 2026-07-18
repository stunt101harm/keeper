# TxLINE Integration

Every endpoint Keeper uses, with the semantics we verified live on **devnet**
(`https://txline-dev.txodds.com`). All data requests carry **two** headers:
`Authorization: Bearer <guest JWT>` and `X-Api-Token: <api token>`.

## Auth chain (free World Cup tier)

| Step | Call | Notes |
|---|---|---|
| 1 | `POST /auth/guest/start` | No body → `{token}` (ES256 JWT, ~30-day TTL). Renew by calling again; data calls answer 401 on expiry. |
| 2 | on-chain `subscribe(serviceLevel=1, weeks=4)` | TxLINE program `6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J`; level 1 costs 0 TxL (SOL fee only); `weeks` must be a multiple of 4. Requires a Token-2022 ATA for the TxL mint `4Zao8ocPhmMgq7PdsYWyxvqySMGx7xb9cMftPMkEokRG` (created first if missing). Keeper's subscribe tx: `5tWHArz9yBEetEkVR3gt7UqJV6GFUnq3wsvCskdX6N6j8mz5LUn92ta1UGCB4RxSBpa1ryjY2rD9meFDfWsNzwbB` |
| 3 | `POST /api/token/activate` | Body `{txSig, walletSignature, leagues:[]}` where walletSignature = base64 nacl detached signature of `` `${txSig}:${leagues.join(',')}:${jwt}` `` by the subscribing wallet → long-lived `X-Api-Token`. |

## Data endpoints

| Endpoint | Used for | Verified semantics |
|---|---|---|
| `GET /api/fixtures/snapshot?competitionId=&startEpochDay=` | Fixture discovery | World Cup = `competitionId 72`; 30-day window from `startEpochDay` (default today). `StartTime` ms epoch; `Participant1IsHome` drives home/away mapping. |
| `GET /api/odds/snapshot/{fixtureId}?asOf=` | Seeding current odds | Array of latest odds per market line; `asOf` (ms) returns the snapshot at any historical instant. |
| `GET /api/odds/stream` (SSE) | Live odds ingest | All permitted fixtures on one stream; named `heartbeat` events every ~15 s (heartbeat `Ts` is **seconds**, record `Ts` is **ms**). |
| `GET /api/odds/updates/{epochDay}/{hourOfDay}/{interval}` | Historical odds reconstruction (replay recordings) | 5-minute buckets, `interval` 0–11, `epochDay = floor(ts/86400000)`. ~1 odds tick/sec per fixture during in-play World Cup coverage. |
| `GET /api/scores/snapshot/{fixtureId}` | Seeding score state | Returns latest record **per Action type**, not merged state — finalisation must be detected by scanning for `StatusId 100` (the max-Seq record of a finished match is a StatusId-less `disconnected`). |
| `GET /api/scores/stream` (SSE) | Live score/event ingest | Same stream mechanics as odds. |
| `GET /api/scores/historical/{fixtureId}` | Full match log for recordings | SSE-formatted **text body** (~1 MB/match), `id` == `Seq`. |
| `GET /api/scores/stat-validation?fixtureId=&seq=&statKeys=` | On-chain proof verification | 1–5 stat keys per request; Merkle proof chain verifies against the `daily_scores_roots` PDA on the devnet program (288 five-minute batch roots/day). |

## The odds records Keeper trades on

Filter: `Bookmaker === 'TXLineStablePriceDemargined'` (BookmakerId 10021) and
`SuperOddsType === '1X2_PARTICIPANT_RESULT'`.

```json
{
  "FixtureId": 18257865,
  "MessageId": "1838256169:00003:000774-10021-stab",
  "Ts": 1784338826662,
  "Bookmaker": "TXLineStablePriceDemargined",
  "SuperOddsType": "1X2_PARTICIPANT_RESULT",
  "InRunning": false,
  "PriceNames": ["part1", "draw", "part2"],
  "Prices": [1952, 4204, 4005],
  "Pct": ["51.230", "23.787", "24.969"]
}
```

- `Prices` are decimal odds ×1000; `Pct` is the **demargined** probability vector (sums ≈ 100)
  — TxODDS's StablePrice engine does the de-vig server-side, which is precisely the fair-value
  input a market maker wants.
- **Empty `Prices`/`Pct` arrays = market suspended** (observed around kickoff and goals).
- `part1`/`part2` map to home/away via the fixture's `Participant1IsHome`.

## Score records

`Action` values observed: `kickoff, goal, corner, yellow_card, red_card, shot,
halftime_finalised (StatusId 3), game_finalised (StatusId 100), comment, disconnected`.
`Stats` keys: 1/2 goals, 3/4 yellows, 5/6 reds, 7/8 corners (participant 1/2); +1000 = H1,
+3000 = H2. `Clock.Seconds` carries match time.
