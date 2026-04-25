// Main PeakPass app — single-file React prototype

const { useState, useEffect, useRef, useMemo } = React;

// ---------- icons (tiny inline SVGs) ----------
const Icon = ({ name, size = 14 }) => {
  const s = { width: size, height: size, strokeWidth: 1.8, fill: "none", stroke: "currentColor", strokeLinecap: "round", strokeLinejoin: "round" };
  switch (name) {
    case "play": return <svg viewBox="0 0 24 24" {...s}><polygon points="6 4 20 12 6 20 6 4" fill="currentColor" stroke="none"/></svg>;
    case "reset": return <svg viewBox="0 0 24 24" {...s}><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 3v6h6"/></svg>;
    case "check": return <svg viewBox="0 0 24 24" {...s}><polyline points="20 6 9 17 4 12"/></svg>;
    case "chev": return <svg viewBox="0 0 24 24" {...s}><polyline points="9 18 15 12 9 6"/></svg>;
    case "chev-d": return <svg viewBox="0 0 24 24" {...s}><polyline points="6 9 12 15 18 9"/></svg>;
    case "copy": return <svg viewBox="0 0 24 24" {...s}><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>;
    case "warn": return <svg viewBox="0 0 24 24" {...s}><path d="M12 2 2 20h20L12 2z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>;
    case "arrow": return <svg viewBox="0 0 24 24" {...s}><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>;
    default: return null;
  }
};

// ---------- Top bar ----------
const TopBar = ({ mode, onToggleMock, apiBase }) => (
  <div className="topbar">
    <div className="topbar-left">
      <div className="logo-mark">
        <span className="logo-dot"/>
        PeakPass<span style={{color:"#8aa2bd", fontWeight:400, marginLeft:4}}>/ ops</span>
      </div>
      <div className="topbar-meta">
        <span>env <b>demo</b></span>
        <span>api <b>{apiBase.replace(/^https?:\/\//, "")}</b></span>
        <span>build <b>2026.04.25</b></span>
      </div>
    </div>
    <div className="topbar-right">
      <span style={{color:"#8aa2bd"}}>mock mode</span>
      <div className={`switch ${mode === "mock" ? "on" : ""}`} onClick={onToggleMock} role="button" aria-label="toggle mock"/>
      <span className={`mode-badge ${mode}`}>
        <span className="pulse"/>
        {mode === "live" ? "LIVE API" : mode === "mock" ? "MOCK MODE" : "OFFLINE"}
      </span>
    </div>
  </div>
);

// ---------- Hero ----------
const Hero = () => (
  <section className="hero">
    <div className="hero-grid">
      <div>
        <div className="hero-eyebrow"><span className="bar"/>Ticketing consistency demo · System walkthrough</div>
        <h1>PeakPass — <em>Ticketing Consistency</em> Demo</h1>
        <p className="hero-sub">예약, 결제 정산, 티켓 발급의 정합성과 멱등성을 시각화한 백엔드 데모. 단계별 흐름을 따라가며 write/read 분리, Source of Truth, webhook 재시도 방어 구조를 확인할 수 있습니다.</p>
        <div className="hero-oneliner">
          <b>쓰기 명령은 REST</b>, <b>읽기 조합은 GraphQL</b>로 분리하고, <b>PostgreSQL을 Source of Truth</b>로 둔 티켓팅 백엔드입니다.
        </div>
        <div className="tech-badges">
          <span className="tech-badge" data-t="ts"><span className="dot"/>TypeScript</span>
          <span className="tech-badge" data-t="fastify"><span className="dot"/>Fastify</span>
          <span className="tech-badge" data-t="gql"><span className="dot"/>Apollo GraphQL</span>
          <span className="tech-badge" data-t="pg"><span className="dot"/>PostgreSQL 16</span>
          <span className="tech-badge" data-t="redis"><span className="dot"/>Redis 7</span>
          <span className="tech-badge" data-t="docker"><span className="dot"/>Docker Compose</span>
          <span className="tech-badge" data-t="k6"><span className="dot"/>k6</span>
        </div>
      </div>
      <div className="hero-stats">
        <div className="stat-card">
          <div className="label">Write endpoints</div>
          <div className="value">3<span className="unit">REST</span></div>
          <div className="sub">reservations · checkouts · settlement</div>
        </div>
        <div className="stat-card">
          <div className="label">Read queries</div>
          <div className="value">5<span className="unit">GraphQL</span></div>
          <div className="sub">events · event · myOrders · myTickets · ticketByCode</div>
        </div>
        <div className="stat-card accent">
          <div className="label">Source of truth</div>
          <div className="value">PostgreSQL</div>
          <div className="sub">Redis = hold TTL / idempotency cache</div>
        </div>
        <div className="stat-card">
          <div className="label">Load target</div>
          <div className="value">p95&lt;120<span className="unit">ms</span></div>
          <div className="sub">k6 smoke · /reservations 200 rps</div>
        </div>
      </div>
    </div>
  </section>
);

// ---------- Architecture strip ----------
const ArchitectureStrip = () => (
  <section className="section">
    <div className="section-head">
      <div className="title-group">
        <span className="section-tag">02 · Architecture</span>
        <h2>Write/Read 분리 · Source of Truth 중심 구조</h2>
      </div>
      <div className="sub">클라이언트 → Fastify → PostgreSQL(최종 정합성) + Redis(보조 계층). write는 REST, read는 GraphQL.</div>
    </div>
    <div className="arch">
      <div className="arch-col client">
        <div className="arch-label">01 · Client</div>
        <div className="arch-node">
          <div className="node-title">Browser / SPA</div>
          <div className="node-sub">Vite · React · fetch()</div>
          <div className="browser-frame"/>
        </div>
      </div>
      <div className="arch-col api">
        <div className="arch-label">02 · Fastify API</div>
        <div className="api-core">
          <div className="port">:3000</div>
          <div className="core-title">Fastify 4.x</div>
          <div className="core-sub">REST · Apollo Server 4 · Zod</div>
        </div>
        <div className="api-paths">
          <div className="api-path write">
            <div className="path-head"><span className="method-chip">WRITE</span>REST commands</div>
            <ul>
              <li><span className="verb">POST</span>/reservations</li>
              <li><span className="verb">POST</span>/checkouts</li>
              <li><span className="verb">POST</span>/webhooks/payments/settlement</li>
            </ul>
          </div>
          <div className="api-path read">
            <div className="path-head"><span className="method-chip">READ</span>GraphQL queries</div>
            <ul>
              <li><span className="verb">qry</span>events</li>
              <li><span className="verb">qry</span>event</li>
              <li><span className="verb">qry</span>myOrders</li>
              <li><span className="verb">qry</span>myTickets</li>
              <li><span className="verb">qry</span>ticketByCode</li>
            </ul>
          </div>
        </div>
      </div>
      <div className="arch-col data">
        <div className="arch-label">03 · Data plane</div>
        <div className="data-node sot">
          <div className="dn-title">PostgreSQL 16 <span className="role">Source of Truth</span></div>
          <ul>
            <li>events · pricing_tiers</li>
            <li>reservations (hold)</li>
            <li>orders · tickets</li>
            <li>payments · webhook_events</li>
          </ul>
        </div>
        <div className="data-node cache">
          <div className="dn-title">Redis 7 <span className="role">Aux layer</span></div>
          <ul>
            <li>hold TTL (seat lock)</li>
            <li>idempotency cache</li>
            <li>rate limit counters</li>
          </ul>
        </div>
      </div>
    </div>
  </section>
);

// ---------- JSON viewer ----------
const JsonView = ({ value, emptyLabel = "—" }) => {
  if (value === undefined || value === null) {
    return <div className="json-block" style={{ color: "#8fa3b8", fontStyle: "italic" }}>{emptyLabel}</div>;
  }
  return <div className="json-block" dangerouslySetInnerHTML={{ __html: highlightJson(value) }}/>;
};

// ---------- Connection panel ----------
const ConnectionPanel = ({ apiBase, setApiBase, mode, setMode, health, ready, onCheckHealth, onCheckReady, onLoadEvents, eventsLoaded }) => (
  <section className="section">
    <div className="section-head">
      <div className="title-group">
        <span className="section-tag">03 · Connection</span>
        <h2>API 연결 확인</h2>
      </div>
      <div className="sub">실제 API에 연결하거나, 실패 시 Mock Mode로 전환해 동일한 상태 전이를 확인합니다.</div>
    </div>
    <div className="conn-panel">
      <div className="conn-card">
        <div className="card-head">
          <div className="card-title">API Base URL</div>
          <span className={`status-pill ${mode === "live" ? "ok" : mode === "mock" ? "warn" : "idle"}`}><span className="dot"/>{mode.toUpperCase()}</span>
        </div>
        <div className="input-row">
          <input className="input" value={apiBase} onChange={e => setApiBase(e.target.value)} placeholder="http://localhost:3000"/>
        </div>
        <div className="btn-row">
          <button className="btn btn-primary" onClick={onCheckHealth}><span>Check</span><code style={{fontFamily:"var(--font-mono)", fontSize:11}}>/health</code></button>
          <button className="btn btn-secondary" onClick={onCheckReady}><span>Check</span><code style={{fontFamily:"var(--font-mono)", fontSize:11}}>/ready</code></button>
          <button className="btn btn-accent" onClick={onLoadEvents}>
            {eventsLoaded ? <><Icon name="check" size={12}/> Events loaded</> : "Load events"}
          </button>
        </div>
        <div style={{marginTop:14, paddingTop:14, borderTop:"1px dashed var(--line)"}}>
          <div className="field-hint">
            💡 API가 응답하지 않으면 상단 토글로 <b>Mock Mode</b>로 전환하세요. 동일한 상태 전이와 중복 방어를 데모용으로 재현합니다.
          </div>
        </div>
      </div>

      <div className="check-card">
        <div className="card-head">
          <div className="card-title">GET /health</div>
          <span className={`status-pill ${health?.ok ? "ok" : health?.err ? "err" : "idle"}`}>
            <span className="dot"/>{health?.ok ? "200 OK" : health?.err ? "ERROR" : "idle"}
          </span>
        </div>
        {health ? (
          <div className="kv-table">
            <div className="k">status</div><div className="v">{health.status || "—"}</div>
            <div className="k">uptime</div><div className="v">{health.uptime ?? "—"}s</div>
            <div className="k">version</div><div className="v">{health.version || "—"}</div>
            <div className="k">node</div><div className="v">{health.node || "—"}</div>
          </div>
        ) : (
          <div className="field-hint">아직 확인하지 않음. <code style={{fontFamily:"var(--font-mono)"}}>Check /health</code> 버튼을 누르세요.</div>
        )}
      </div>

      <div className="check-card">
        <div className="card-head">
          <div className="card-title">GET /ready</div>
          <span className={`status-pill ${ready?.ok ? "ok" : ready?.err ? "err" : "idle"}`}>
            <span className="dot"/>{ready?.ok ? "READY" : ready?.err ? "NOT READY" : "idle"}
          </span>
        </div>
        {ready ? (
          <>
            <div className="metric-row">
              <span className="key">postgres</span>
              <span className={`status-pill ${ready.postgres === "ok" ? "ok" : "err"}`}><span className="dot"/>{ready.postgres}</span>
            </div>
            <div className="metric-row">
              <span className="key">redis</span>
              <span className={`status-pill ${ready.redis === "ok" ? "ok" : "err"}`}><span className="dot"/>{ready.redis}</span>
            </div>
            <div className="metric-row">
              <span className="key">latency</span>
              <span className="val">pg {ready.pgLatency}ms · redis {ready.redisLatency}ms</span>
            </div>
          </>
        ) : (
          <div className="field-hint">postgres/redis 각각의 연결을 분리해서 확인합니다.</div>
        )}
      </div>
    </div>
  </section>
);

Object.assign(window, { TopBar, Hero, ArchitectureStrip, JsonView, ConnectionPanel, Icon });
