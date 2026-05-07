// Demo flow — steps, state inspector, request log, explanation notes, ticket card

const { useState: useStateF, useEffect: useEffectF, useMemo: useMemoF, useRef: useRefF } = React;

// ---------- Ticket card ----------
const TicketCard = ({ ticket, event }) => {
  const cells = qrPattern(ticket.ticketNumber || "");
  return (
    <div className="ticket">
      <div>
        <div className="t-event">ISSUED · {event?.name?.split("—")[0]?.trim() || "Event"}</div>
        <div className="t-title">{event?.name || "Ticket"}</div>
        <div className="t-code">{ticket.ticketNumber}</div>
        <div className="t-meta">
          {ticket.tier} · {ticket.seat || "자유석"} · {fmtDate(ticket.issuedAt)}
        </div>
      </div>
      <div className="t-qr">
        {cells.map((on, i) => <span key={i} className={on ? "" : "off"}/>)}
      </div>
    </div>
  );
};

// ---------- Step wrapper ----------
const StepCard = ({ n, title, endpoint, method, status, active, onToggle, expanded, timing, children }) => {
  const cls = `step ${status} ${active ? "active" : ""}`;
  return (
    <div className={cls}>
      <div className="step-head" onClick={onToggle}>
        <div className="step-num">{status === "done" ? <Icon name="check" size={14}/> : n}</div>
        <div className="step-title-block">
          <div className="step-title">{title}</div>
          <div className="step-meta">
            {endpoint && <span className={`endpoint-chip ${method === "GQL" || method === "GET" ? "read" : "write"}`}>{method} {endpoint}</span>}
            {status === "idle" && <span style={{color:"var(--muted-2)"}}>대기 중</span>}
            {status === "running" && <span style={{color:"var(--blue)"}}>실행 중…</span>}
            {status === "done" && <span style={{color:"var(--green)"}}>완료</span>}
            {status === "error" && <span style={{color:"var(--red)"}}>에러</span>}
          </div>
        </div>
        <div className="step-timing">
          {timing ? <><div className="t">{timing}ms</div><div>elapsed</div></> : <span style={{color:"var(--muted-2)"}}>—</span>}
        </div>
        <div style={{color:"var(--muted)", transform: expanded ? "rotate(90deg)" : "none", transition:"transform 0.15s"}}>
          <Icon name="chev" size={16}/>
        </div>
      </div>
      {expanded && <div className="step-body">{children}</div>}
    </div>
  );
};

// ---------- The 7-step flow ----------
const DemoFlow = ({ state, actions }) => {
  const {
    mode, events, selectedEventId, selectedTierId, userId, quantity,
    reservation, order, settlement, duplicateReplay, duplicateSemantic,
    ticketByCode, stepStatus, stepTiming, requests, activeStep, expandedSteps,
    checkoutIdemKey, settlementIdemKey, providerTxnId,
    dupBusy = { A: false, B: false } // [FIX] per-button busy flags for Step 6
  } = state;

  const selectedEvent = events?.find(e => e.id === selectedEventId);
  const selectedTier = selectedEvent?.pricing?.find(p => p.tierId === selectedTierId);
  const orderStatus = order?.order?.status;
  const paymentStatus = settlement?.paymentStatus || settlement?.order?.paymentStatus;
  const tickets = settlement?.tickets || order?.tickets || [];
  const liveWebhookDisabled = mode === "live";

  const pct = Math.round((Object.values(stepStatus).filter(s => s === "done").length / 7) * 100);

  return (
    <section className="section">
      <div className="section-head">
        <div className="title-group">
          <span className="section-tag">04 · Demo Flow</span>
          <h2>예약 → 결제 → 정산 → 티켓 발급</h2>
        </div>
        <div className="sub">각 단계는 REST/GraphQL 실제 호출을 시뮬레이트합니다. 수동 실행도 가능하고 <b>Run Full Demo</b>로 전체 순차 실행도 가능합니다.</div>
      </div>

      <div className="flow-wrap">
        <div className="flow-main">
          <div className="run-bar">
            <div className="rb-left">
              <b>RUN FULL DEMO</b>
              <div className="progress"><div className="bar" style={{width: `${pct}%`}}/></div>
              <span>{pct}% · {Object.values(stepStatus).filter(s => s === "done").length}/7 steps</span>
            </div>
            <div className="rb-right">
              <button className="btn btn-ghost" onClick={actions.reset} style={{color:"#dfe8f2"}}>
                <Icon name="reset" size={13}/> Reset
              </button>
              <button className="btn btn-warn" onClick={actions.runAll} disabled={liveWebhookDisabled}>
                <Icon name="play" size={12}/> Run Full Demo
              </button>
            </div>
          </div>

          {/* STEP 1 */}
          <StepCard
            n="1" title="GraphQL로 이벤트 조회"
            endpoint="/graphql" method="POST"
            status={stepStatus.s1}
            active={activeStep === 1}
            expanded={expandedSteps.s1}
            onToggle={() => actions.toggleStep("s1")}
            timing={stepTiming.s1}
          >
            <div style={{fontSize:13, color:"var(--ink-2)", marginBottom:10}}>
              읽기 조합은 GraphQL로 담당합니다. 다음 쿼리로 이벤트 목록과 각 tier의 정원을 한 번에 가져옵니다:
            </div>
            <div className="json-block" style={{maxHeight:160}}>
{`query Events($limit: Int, $offset: Int) {
  events(limit: $limit, offset: $offset) {
    id name description startsAt totalSeats availableSeats
    pricing { tierId name price seats }
  }
}`}
            </div>
            <div className="btn-row" style={{marginTop:12}}>
              <button className="btn btn-accent" onClick={actions.step1} disabled={stepStatus.s1 === "running"}>
                <Icon name="play" size={11}/> 실행 — Load events
              </button>
            </div>
            {events && (
              <>
                <div style={{marginTop:16}}>
                  <div className="field-label">응답 · {events.length}개 이벤트</div>
                  <div className="event-grid" style={{marginTop:8}}>
                    {events.map(ev => {
                      const ratio = ev.availableSeats / ev.totalSeats;
                      const cls = ratio < 0.1 ? "crit" : ratio < 0.3 ? "low" : "";
                      return (
                        <div key={ev.id}
                             className={`event-card ${selectedEventId === ev.id ? "selected" : ""}`}
                             onClick={() => actions.selectEvent(ev.id)}>
                          <div className="event-date">{fmtDate(ev.startsAt)}</div>
                          <div className="event-title">{ev.name}</div>
                          <div className="event-meta">
                            <span>{ev.availableSeats.toLocaleString()} / {ev.totalSeats.toLocaleString()} 좌석</span>
                            <span>{ev.pricing.length} tiers</span>
                          </div>
                          <div className="capacity-bar"><div className={`fill ${cls}`} style={{width: `${ratio * 100}%`}}/></div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </>
            )}
          </StepCard>

          {/* STEP 2 */}
          <StepCard
            n="2" title="이벤트 · tier · 수량 · userId 선택"
            status={stepStatus.s2}
            active={activeStep === 2}
            expanded={expandedSteps.s2}
            onToggle={() => actions.toggleStep("s2")}
          >
            {!selectedEvent ? (
              <div style={{padding:"16px 0", color:"var(--muted)", fontSize:13}}>Step 1에서 이벤트를 먼저 선택하세요.</div>
            ) : (
              <>
                <div className="field-block" style={{marginTop:8}}>
                  <div className="field-label">Selected Event</div>
                  <div style={{fontFamily:"var(--font-display)", fontWeight:500, fontSize:17}}>{selectedEvent.name}</div>
                  <div style={{fontFamily:"var(--font-mono)", fontSize:11.5, color:"var(--muted)"}}>
                    {selectedEvent.id} · {fmtDate(selectedEvent.startsAt)}
                  </div>
                </div>

                <div className="field-block" style={{marginTop:14}}>
                  <div className="field-label">Pricing Tier</div>
                  <div className="tier-grid">
                    {selectedEvent.pricing.map(p => (
                      <div key={p.tierId}
                           className={`tier-card ${selectedTierId === p.tierId ? "selected" : ""}`}
                           onClick={() => actions.selectTier(p.tierId)}>
                        <div className="tier-name">{p.name}</div>
                        <div className="tier-price">{fmtKRW(p.price)}</div>
                        <div className="tier-sub">정원 {p.seats.toLocaleString()}석</div>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="grid-2">
                  <div className="field-block">
                    <div className="field-label">Quantity</div>
                    <input className="input small" type="number" min="1" max="4" value={quantity}
                           onChange={e => actions.setQuantity(parseInt(e.target.value) || 1)}/>
                    <div className="field-hint">최대 4매 (브라우저에서만 제한, 서버는 reservation hold 로직으로 다시 검증)</div>
                  </div>
                  <div className="field-block">
                    <div className="field-label">User ID (seed)</div>
                    <input className="input small" value={userId} onChange={e => actions.setUserId(e.target.value)}/>
                    <div className="field-hint">
                      <Icon name="warn" size={11}/> 로컬에서는 <code style={{fontFamily:"var(--font-mono)"}}>npm run seed</code> 로그 또는 DB 조회로 seed userId를 확인해 입력하세요. 프론트는 백엔드 인증 구조를 변경하지 않습니다.
                    </div>
                  </div>
                </div>

                <div className="btn-row" style={{marginTop:14}}>
                  <button className="btn btn-primary" disabled={!selectedTierId || !userId} onClick={() => { actions.markStepDone("s2"); actions.gotoStep(3); }}>
                    <Icon name="check" size={12}/> 선택 확정 · 다음 단계로
                  </button>
                </div>
              </>
            )}
          </StepCard>

          {/* STEP 3 */}
          <StepCard
            n="3" title="Reservation Hold 생성"
            endpoint="/reservations" method="POST"
            status={stepStatus.s3}
            active={activeStep === 3}
            expanded={expandedSteps.s3}
            onToggle={() => actions.toggleStep("s3")}
            timing={stepTiming.s3}
          >
            <div style={{fontSize:13, color:"var(--ink-2)", marginBottom:10}}>
              좌석 선점(hold)은 REST <b>command</b> 입니다. Redis에 TTL 기반 락을 잡고, PostgreSQL에도 <code style={{fontFamily:"var(--font-mono)"}}>reservations</code> 레코드를 남깁니다.
              <span style={{display:"block", color:"var(--muted)", fontSize:12, marginTop:4}}>
                ⓘ Redis hold TTL은 <b>보조 계층</b>입니다. Source of Truth는 PostgreSQL의 reservation 레코드입니다.
              </span>
            </div>
            <div className="grid-2">
              <div>
                <div className="field-label" style={{marginBottom:4}}>Request Body</div>
                <JsonView value={selectedEvent && selectedTier && userId ? {
                  eventId: selectedEvent.id,
                  userId,
                  quantity,
                  tierId: selectedTier.tierId
                } : null}/>
              </div>
              <div>
                <div className="field-label" style={{marginBottom:4}}>Response</div>
                <JsonView value={reservation} emptyLabel="아직 실행되지 않음"/>
              </div>
            </div>
            <div className="btn-row" style={{marginTop:12}}>
              <button className="btn btn-danger" onClick={actions.step3}
                      disabled={!selectedTier || !userId || stepStatus.s3 === "running"}>
                <Icon name="play" size={11}/> POST /reservations
              </button>
            </div>
            {reservation && (
              <div className="result-banner pending">
                <div className="rb-icon">H</div>
                <div>
                  <div className="rb-title">Hold 성공 — reservation.status = {reservation.status}</div>
                  <div className="rb-sub">expiresAt: {fmtDate(reservation.expiresAt)} · Redis TTL 기반</div>
                </div>
                <div className="rb-stat">
                  <div className="stat"><div className="n">{reservation.quantity}</div><div className="l">seats</div></div>
                </div>
              </div>
            )}
          </StepCard>

          {/* STEP 4 */}
          <StepCard
            n="4" title="Checkout — pending order 생성"
            endpoint="/checkouts" method="POST"
            status={stepStatus.s4}
            active={activeStep === 4}
            expanded={expandedSteps.s4}
            onToggle={() => actions.toggleStep("s4")}
            timing={stepTiming.s4}
          >
            <div style={{fontSize:13, color:"var(--ink-2)"}}>
              결제 요청 직전 주문을 만듭니다. <b>이 시점엔 ticket이 발급되지 않습니다.</b> 결제 실패/재시도 비용을 낮추기 위해 티켓 발급은 settlement 이후로 미뤘습니다.
            </div>
            <div className="idem-ribbon">
              <span className="label">Idempotency-Key</span>
              <span className="key">{checkoutIdemKey || "— 실행 시 생성"}</span>
              <button className="regen" onClick={actions.regenCheckoutKey}>재생성</button>
            </div>
            <div className="grid-2">
              <div>
                <div className="field-label" style={{marginBottom:4}}>Request Body</div>
                <JsonView value={selectedEvent && selectedTier && reservation ? {
                  eventId: selectedEvent.id,
                  userId,
                  quantity,
                  tierId: selectedTier.tierId,
                  reservationId: reservation.id
                } : null}/>
              </div>
              <div>
                <div className="field-label" style={{marginBottom:4}}>Response</div>
                <JsonView value={order} emptyLabel="아직 실행되지 않음"/>
              </div>
            </div>
            <div className="btn-row" style={{marginTop:12}}>
              <button className="btn btn-danger" onClick={actions.step4}
                      disabled={!reservation || stepStatus.s4 === "running"}>
                <Icon name="play" size={11}/> POST /checkouts
              </button>
            </div>
            {order && (
              <div className="result-banner pending">
                <div className="rb-icon">P</div>
                <div>
                  <div className="rb-title">order: <span style={{color:"#8c6a1f"}}>PENDING</span> · ticket: <span style={{color:"#8e2f2f"}}>NOT ISSUED</span></div>
                  <div className="rb-sub">checkout 직후에는 주문만 존재. 티켓 발급은 settlement 이후로 지연.</div>
                </div>
                <div className="rb-stat">
                  <div className="stat"><div className="n" style={{color:"var(--red)"}}>0</div><div className="l">tickets</div></div>
                  <div className="stat"><div className="n">{order.order?.totalAmount ? fmtKRW(order.order.totalAmount) : "—"}</div><div className="l">total</div></div>
                </div>
              </div>
            )}
          </StepCard>

          {/* STEP 5 */}
          <StepCard
            n="5" title="Settlement Webhook — 티켓 발급"
            endpoint="/webhooks/payments/settlement" method="POST"
            status={stepStatus.s5}
            active={activeStep === 5}
            expanded={expandedSteps.s5}
            onToggle={() => actions.toggleStep("s5")}
            timing={stepTiming.s5}
          >
            <div style={{fontSize:13, color:"var(--ink-2)"}}>
              PG사가 보낸 정산 webhook을 처리합니다. 이 시점에만 <code style={{fontFamily:"var(--font-mono)"}}>tickets</code>가 생성됩니다.
            </div>
            {liveWebhookDisabled && (
              <div className="field-hint" style={{marginTop:8}}>
                Live mode disables browser-triggered webhooks. Real webhook calls require an HMAC signature, and the signing secret must never be exposed to the client. Use mock mode for this step.
              </div>
            )}
            <div className="idem-ribbon">
              <span className="label">Idempotency-Key</span>
              <span className="key">{settlementIdemKey || "— 실행 시 생성"}</span>
              <span style={{marginLeft:12, color:"#7a4620"}}>· providerTxnId</span>
              <span className="key" style={{marginLeft:0}}>{providerTxnId || "—"}</span>
              <button className="regen" onClick={actions.regenSettlementKey}>재생성</button>
            </div>
            <div className="grid-2">
              <div>
                <div className="field-label" style={{marginBottom:4}}>Request Body</div>
                <JsonView value={order ? {
                  orderId: order.order?.id,
                  providerTransactionId: providerTxnId,
                  status: "settled"
                } : null}/>
              </div>
              <div>
                <div className="field-label" style={{marginBottom:4}}>Response</div>
                <JsonView value={settlement} emptyLabel="아직 실행되지 않음"/>
              </div>
            </div>
            <div className="btn-row" style={{marginTop:12}}>
              <button className="btn btn-danger" onClick={actions.step5}
                      disabled={!order || stepStatus.s5 === "running" || liveWebhookDisabled}>
                <Icon name="play" size={11}/> POST /webhooks/payments/settlement
              </button>
            </div>
            {settlement && (
              <>
                <div className="result-banner paid">
                  <div className="rb-icon"><Icon name="check" size={16}/></div>
                  <div>
                    <div className="rb-title">order: <span style={{color:"#206a41"}}>PAID</span> · payment: <span style={{color:"#206a41"}}>SETTLED</span> · ticket: <span style={{color:"#206a41"}}>ISSUED</span></div>
                    <div className="rb-sub">settlement 이후에만 티켓이 발급됩니다. 각 티켓은 UNIQUE(order_id, seat)로 보호.</div>
                  </div>
                  <div className="rb-stat">
                    <div className="stat"><div className="n" style={{color:"var(--green)"}}>{tickets.length}</div><div className="l">tickets</div></div>
                  </div>
                </div>
                <div className="ticket-wrap">
                  {tickets.map(t => <TicketCard key={t.id} ticket={t} event={selectedEvent}/>)}
                </div>
              </>
            )}
          </StepCard>

          {/* STEP 6 */}
          <StepCard
            n="6" title="Duplicate / Retry — 멱등성 증명"
            status={stepStatus.s6}
            active={activeStep === 6}
            expanded={expandedSteps.s6}
            onToggle={() => actions.toggleStep("s6")}
          >
            <div style={{fontSize:13, color:"var(--ink-2)"}}>
              Webhook은 재시도/중복 호출이 흔합니다. PeakPass는 두 층의 방어를 둡니다:
              <b> (A) Idempotency-Key 캐시</b> 리플레이, <b>(B) DB UNIQUE 제약</b>을 통한 의미적 중복 방어. 두 케이스 모두 <b>티켓 수가 늘지 않습니다</b>.
            </div>
            <div className="dup-grid">
              <div className="dup-card">
                <h4>
                  <span className="status-pill info"><span className="dot"/>A</span>
                  Cache replay — same Idempotency-Key
                </h4>
                <div className="dup-desc">
                  동일 <code style={{fontFamily:"var(--font-mono)"}}>Idempotency-Key</code>와 동일 body. Redis의 idempotency cache가 저장해 둔 기존 응답을 그대로 반환합니다.
                </div>
                <button className="btn btn-secondary" onClick={actions.runDupReplay}
                        disabled={!settlement || dupBusy.A || liveWebhookDisabled}>
                  <Icon name="play" size={11}/>
                  {dupBusy.A ? "실행 중…" : (duplicateReplay ? "Replay webhook (재실행)" : "Replay webhook")}
                </button>
                {duplicateReplay && (
                  <div className="dup-result">
                    <div>status · <b style={{color:"#206a41"}}>200 (cache hit)</b></div>
                    <div>tickets · <b>{duplicateReplay.tickets?.length ?? tickets.length}</b> <span style={{color:"var(--green)"}}>(unchanged)</span></div>
                    <div>duplicate · <b>{String(duplicateReplay.duplicate ?? true)}</b></div>
                    <div style={{color:"var(--muted)", marginTop:4}}>source: redis idempotency:settlement:{(settlementIdemKey || "").slice(0,8)}</div>
                  </div>
                )}
              </div>

              <div className="dup-card">
                <h4>
                  <span className="status-pill info"><span className="dot"/>B</span>
                  Semantic duplicate — same provider transaction
                </h4>
                <div className="dup-desc">
                  <b>새로운</b> Idempotency-Key지만 동일 <code style={{fontFamily:"var(--font-mono)"}}>orderId / providerTransactionId</code>. Redis 캐시를 지나가더라도 DB <code style={{fontFamily:"var(--font-mono)"}}>UNIQUE(provider_txn_id)</code> 위반으로 방어됩니다.
                </div>
                <button className="btn btn-secondary" onClick={actions.runDupSemantic}
                        disabled={!settlement || dupBusy.B || liveWebhookDisabled}>
                  <Icon name="play" size={11}/>
                  {dupBusy.B ? "실행 중…" : (duplicateSemantic ? "Semantic duplicate (재실행)" : "Semantic duplicate")}
                </button>
                {duplicateSemantic && (
                  <div className="dup-result">
                    <div>status · <b style={{color:"#206a41"}}>200 (idempotent)</b></div>
                    <div>tickets · <b>{duplicateSemantic.tickets?.length ?? tickets.length}</b> <span style={{color:"var(--green)"}}>(unchanged)</span></div>
                    <div>duplicate · <b>true</b></div>
                    <div style={{color:"var(--muted)", marginTop:4}}>guarded by: payments.provider_txn_id UNIQUE</div>
                  </div>
                )}
              </div>
            </div>
          </StepCard>

          {/* STEP 7 */}
          <StepCard
            n="7" title="Read-side Verification — GraphQL ticketByCode"
            endpoint="/graphql" method="POST"
            status={stepStatus.s7}
            active={activeStep === 7}
            expanded={expandedSteps.s7}
            onToggle={() => actions.toggleStep("s7")}
            timing={stepTiming.s7}
          >
            <div style={{fontSize:13, color:"var(--ink-2)", marginBottom:10}}>
              발급된 티켓 코드로 read path를 검증합니다. GraphQL 한 번의 round-trip으로 ticket + event + order를 조합 조회합니다.
            </div>
            <div className="json-block" style={{maxHeight:180}}>
{`query TicketByCode($code: String!) {
  ticketByCode(code: $code) {
    valid
    status
    ticketNumber
    eventName
    startsAt
    endsAt
  }
}`}
            </div>
            <div style={{marginTop:12, display:"flex", gap:8, alignItems:"center"}}>
              <input className="input small" style={{maxWidth:280}}
                     placeholder="티켓 코드 (예: PP-A4F2-9K3X)"
                     value={state.lookupCode}
                     onChange={e => actions.setLookupCode(e.target.value)}/>
              <button className="btn btn-accent" onClick={actions.step7}
                      disabled={!state.lookupCode || stepStatus.s7 === "running"}>
                <Icon name="play" size={11}/> Query ticketByCode
              </button>
              {tickets.length > 0 && (
                <button className="btn btn-ghost" onClick={() => actions.setLookupCode(tickets[0].ticketNumber)}>
                  <Icon name="copy" size={11}/> 발급된 코드 사용
                </button>
              )}
            </div>
            {ticketByCode && (
              <div style={{marginTop:12}}>
                <div className="field-label" style={{marginBottom:4}}>Response · data.ticketByCode</div>
                <JsonView value={ticketByCode}/>
              </div>
            )}
            <div style={{marginTop:12, fontSize:12, color:"var(--muted)"}}>
              ⓘ <b>myOrders / myTickets</b>는 JWT가 필요합니다. 이 데모에선 필수 플로우에서 제외했습니다.
            </div>
          </StepCard>
        </div>

        {/* sidebar */}
        <aside className="flow-side">
          <StateInspector state={state}/>
          <ExplanationNotes activeStep={activeStep}/>
        </aside>
      </div>
    </section>
  );
};

// ---------- State inspector ----------
const StateInspector = ({ state }) => {
  const rows = [
    ["mode", state.mode.toUpperCase()],
    ["selectedEvent", state.events?.find(e => e.id === state.selectedEventId)?.name || "—"],
    ["selectedTier", state.events?.find(e => e.id === state.selectedEventId)?.pricing?.find(p => p.tierId === state.selectedTierId)?.name || "—"],
    ["userId", state.userId || "—"],
    ["quantity", state.quantity],
    ["reservationId", state.reservation?.id || "—"],
    ["reservation.status", state.reservation?.status || "—"],
    ["checkoutIdempotencyKey", state.checkoutIdemKey ? fmtShort(state.checkoutIdemKey, 16) : "—"],
    ["orderId", state.order?.order?.id || "—"],
    ["orderStatus", (state.settlement?.order?.status || state.order?.order?.status || "—")],
    ["paymentStatus", state.settlement?.paymentStatus || state.settlement?.order?.paymentStatus || "—"],
    ["settlementIdempotencyKey", state.settlementIdemKey ? fmtShort(state.settlementIdemKey, 16) : "—"],
    ["providerTransactionId", state.providerTxnId || "—"],
    ["ticketCount", (state.settlement?.tickets || state.order?.tickets || []).length],
    ["ticketNumbers", ((state.settlement?.tickets || []).map(t => t.ticketNumber).join(", ")) || "—"],
    ["duplicateResult", state.duplicateReplay || state.duplicateSemantic ? "unchanged ✓" : "—"],
  ];
  const highlightKeys = ["orderStatus", "paymentStatus", "ticketCount"];
  return (
    <div className="inspector">
      <div className="inspector-head">
        <span className="t">State Inspector</span>
        <span style={{fontFamily:"var(--font-mono)", fontSize:10, color:"#8aa2bd"}}>LIVE · {rows.length} keys</span>
      </div>
      <div className="inspector-body">
        {rows.map(([k, v]) => (
          <div className="insp-row" key={k}>
            <span className="k">{k}</span>
            <span className={`v ${v === "—" ? "empty" : ""} ${highlightKeys.includes(k) && v !== "—" && v !== 0 ? "highlight" : ""}`}>{String(v)}</span>
          </div>
        ))}
      </div>
    </div>
  );
};

// ---------- Explanation notes ----------
const EXPLANATION_NOTES = {
  1: [
    { b: "READ", t: "REST는 상태 변경 명령만 담당합니다." },
    { b: "GRAPHQL", t: "GraphQL은 조회 조합을 담당해 write schema 변경을 줄입니다." },
    { b: "N+1", t: "DataLoader로 pricing 조회를 배치하고 N+1을 막습니다." },
  ],
  2: [
    { b: "SEED", t: "userId는 DB seed 스크립트로 생성됩니다. 프론트는 backend 인증을 변경하지 않습니다." },
    { b: "ZOD", t: "모든 request body는 Zod로 검증한 후 핸들러에 진입합니다." },
  ],
  3: [
    { b: "HOLD", t: "예약은 Redis hold TTL로 빠르게 좌석을 잡고, PostgreSQL에도 동시에 기록합니다." },
    { b: "SOT", t: "Redis는 빠른 캐시/락 계층이지만 최종 정합성 기준은 PostgreSQL입니다." },
    { b: "RETRY", t: "TTL 만료 시 reservation 레코드도 EXPIRED로 전환됩니다." },
  ],
  4: [
    { b: "PENDING", t: "checkout은 pending order만 만들고 ticket은 만들지 않습니다." },
    { b: "DEFER", t: "티켓 발급 시점을 settlement 이후로 늦춰 결제 실패/재시도 보정 비용을 낮췄습니다." },
    { b: "IDEMP", t: "Idempotency-Key 헤더로 중복 checkout을 막습니다." },
  ],
  5: [
    { b: "ISSUE", t: "settlement 이후에만 ticket row가 INSERT됩니다." },
    { b: "HMAC", t: "실제 서버에서는 WEBHOOK_SIGNING_SECRET로 HMAC 서명을 검증합니다." },
    { b: "TX", t: "payment.status, order.status, tickets INSERT가 단일 트랜잭션에서 일어납니다." },
  ],
  6: [
    { b: "CACHE", t: "같은 Idempotency-Key면 Redis가 기존 응답을 그대로 반환합니다." },
    { b: "UNIQUE", t: "DB는 payments.provider_txn_id UNIQUE로 의미적 중복을 다시 막습니다." },
    { b: "WHY", t: "Idempotency-Key와 DB UNIQUE 제약으로 중복 webhook을 이중 방어합니다." },
  ],
  7: [
    { b: "READ", t: "ticketByCode 하나의 쿼리로 ticket, event, order를 조합 조회합니다." },
    { b: "JWT", t: "myOrders/myTickets는 JWT 컨텍스트 기반이므로 데모에서는 제외했습니다." },
  ],
};

const ExplanationNotes = ({ activeStep }) => {
  const notes = EXPLANATION_NOTES[activeStep] || EXPLANATION_NOTES[1];
  return (
    <div className="notes-card">
      <div className="nc-head">▸ 설명 포인트 · Step {activeStep}</div>
      {notes.map((n, i) => (
        <div className="note" key={i}>
          <span className="badge">{n.b}</span>
          <p><b>{n.t.split(/\s+/).slice(0,1).join(" ")}</b> {n.t.split(/\s+/).slice(1).join(" ")}</p>
        </div>
      ))}
    </div>
  );
};

// ---------- Request log ----------
const RequestLog = ({ requests, onClear }) => {
  const [openIdx, setOpenIdx] = useStateF(new Set());
  const toggle = (i) => {
    const n = new Set(openIdx);
    n.has(i) ? n.delete(i) : n.add(i);
    setOpenIdx(n);
  };
  return (
    <section className="section">
      <div className="section-head">
        <div className="title-group">
          <span className="section-tag">05 · Request log</span>
          <h2>각 단계 API 호출 내역</h2>
        </div>
        <div className="sub">각 API가 어떤 상태 변화를 만들었는지 확인할 수 있도록 raw 요청/응답을 기록합니다.</div>
      </div>
      <div className="log-card">
        <div className="log-head">
          <span>METHOD · ENDPOINT · STATUS · ELAPSED</span>
          <button className="btn btn-ghost" onClick={onClear} style={{fontSize:11}}>CLEAR</button>
        </div>
        {requests.length === 0 ? (
          <div className="log-empty">아직 호출 없음 — 위 Step을 실행하면 여기 기록됩니다.</div>
        ) : requests.map((r, i) => (
          <div key={i} className="log-entry">
            <div className="le-head" onClick={() => toggle(i)}>
              <span className={`method ${r.method}`}>{r.method === "GQL" ? "GQL" : r.method}</span>
              <span style={{fontFamily:"var(--font-mono)", fontSize:11, color:"var(--muted)"}}>#{String(i+1).padStart(2,"0")}</span>
              <span className="url">{r.url}{r.idemKey ? ` · Idem: ${fmtShort(r.idemKey, 10)}` : ""}</span>
              <span className={`status s${String(r.status)[0]}`}>{r.status}</span>
              <span className="elapsed">{r.elapsed}ms</span>
              <span className="chev" style={{transform: openIdx.has(i) ? "rotate(180deg)" : "none", transition:"transform 0.15s"}}>
                <Icon name="chev-d" size={12}/>
              </span>
            </div>
            {openIdx.has(i) && (
              <div className="le-body">
                <div className="lb-col">
                  <div className="lb-label">Request</div>
                  <JsonView value={r.request}/>
                </div>
                <div className="lb-col">
                  <div className="lb-label">Response</div>
                  <JsonView value={r.response}/>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
};

Object.assign(window, { DemoFlow, StateInspector, ExplanationNotes, RequestLog, TicketCard, StepCard });
