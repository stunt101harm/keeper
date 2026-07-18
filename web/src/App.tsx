import { OUTCOMES, OUTCOME_COLOR, OUTCOME_LABEL } from './domain';
import { fmtPct } from './format';
import { useStore } from './hooks';
import { BookPanel } from './components/BookPanel';
import { ChainPanel } from './components/ChainPanel';
import { Header } from './components/Header';
import { MoneyChart } from './components/MoneyChart';
import { QuoteBoard } from './components/QuoteBoard';
import { RiskLogPanel } from './components/RiskLogPanel';
import { SettlementBanner } from './components/SettlementBanner';

export function App() {
  const store = useStore();
  const bufs = [...store.fixtures.values()];
  const buf = store.selectedFixture ? (store.fixtures.get(store.selectedFixture) ?? null) : null;
  const latest = buf?.latestQuotes ?? null;
  const lastFair = latest?.fair ?? buf?.fairTicks.at(-1)?.fair ?? null;
  const kickoffTs = buf?.fixture?.kickoffTs ?? buf?.chart[0]?.ts ?? buf?.fairTicks[0]?.ts ?? 0;

  const cap = typeof store.params.inventoryCap === 'number' ? store.params.inventoryCap : undefined;

  return (
    <div className="app">
      <Header buf={buf} />

      <SettlementBanner buf={buf} />

      {bufs.length > 1 && (
        <div className="tabs">
          {bufs.map((b) => (
            <button
              key={b.id}
              className={`tab ${b.id === store.selectedFixture ? 'active' : ''}`}
              onClick={() => store.select(b.id)}
            >
              {b.fixture ? `${b.fixture.home} v ${b.fixture.away}` : b.id}
            </button>
          ))}
        </div>
      )}

      <div className="grid">
        <div className="col">
          <div className="panel">
            <div className="panel-title">
              Market — fair value &amp; our quotes
              <span className="legend" style={{ marginLeft: 10 }}>
                {OUTCOMES.map((o) => (
                  <span className="item" key={o}>
                    <span className="swatch" style={{ background: OUTCOME_COLOR[o] }} />
                    {OUTCOME_LABEL[o]}
                    <span className="num ink2">{lastFair ? fmtPct(lastFair[o]) : '—'}</span>
                  </span>
                ))}
                <span className="item muted">line = consensus fair · band = our bid–ask</span>
                <span className="item muted">▲ buy fill · ▼ sell fill · shaded = freeze</span>
              </span>
            </div>
            {buf ? (
              <MoneyChart buf={buf} kickoffTs={kickoffTs} />
            ) : (
              <div className="empty-note" style={{ height: 380 }}>
                {store.hydrated ? 'no fixtures tracked yet' : 'connecting…'}
              </div>
            )}
          </div>

          <BookPanel buf={buf} inventoryCap={cap} />
        </div>

        <div className="col">
          <QuoteBoard buf={buf} />
          <ChainPanel />
          <RiskLogPanel buf={buf} />
        </div>
      </div>
    </div>
  );
}
