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
          {ticket.tier} · {ticket.seat || "자유석"} · {fmtDate(ticket.createdAt)}
        </div>
      </div>
      <div className="t-qr">
        {cells.map((on, i) => <span key={i} className={on ? "" : "off"}/>)}
      </div>
    </div>
  );
};

// ---------- Step wrapper ----------
const StepCard = ({ n, title, endpoint, method, status, statusLabel, active, onToggle, expanded, timing, children }) => {
  const cls = `step ${status} ${active ? "active" : ""}`;
  return (
    <div className={cls}>
      <button type="button" className="step-head" onClick={onToggle} aria-expanded={expanded}>
        <span className="step-num">{status === "done" ? <Icon name="check" size={14}/> : n}</span>
        <span className="step-title-block">
          <span className="step-title">{title}</span>
          <span className="step-meta">
            {endpoint && <span className={`endpoint-chip ${method === "GQL" || method === "GET" ? "read" : "write"}`}>{method} {endpoint}</span>}
            {statusLabel}
            {!statusLabel && status === "idle" && <span style={{color:"var(--muted-2)"}}>대기 중</span>}
            {!statusLabel && status === "running" && <span style={{color:"var(--blue)"}}>실행 중…</span>}
            {!statusLabel && status === "done" && <span style={{color:"var(--green)"}}>완료</span>}
            {!statusLabel && status === "error" && <span style={{color:"var(--red)"}}>에러</span>}
          </span>
        </span>
        <span className="step-timing">
          {timing ? <><span className="t">{timing}ms</span><span>elapsed</span></> : <span style={{color:"var(--muted-2)"}}>—</span>}
        </span>
        <span style={{color:"var(--muted)", transform: expanded ? "rotate(90deg)" : "none", transition:"transform 0.15s"}}>
          <Icon name="chev" size={16}/>
        </span>
      </button>
      {expanded && <div className="step-body">{children}</div>}
    </div>
  );
};

// ---------- Admission queue card (live mode) ----------
// A state is told apart by its label and text, never by colour alone.
const QUEUE_PHASES = {
  loading:       { pill: "idle", label: "확인 중",       tone: "",        mark: "…" },
  "not-enabled": { pill: "idle", label: "대기열 미적용", tone: "",        mark: "—" },
  "not-joined":  { pill: "idle", label: "미등록",        tone: "",        mark: "+" },
  waiting:       { pill: "info", label: "대기 중",       tone: "waiting", mark: "Q" },
  admitted:      { pill: "ok",   label: "입장",          tone: "ok",      mark: "✓" },
  processing:    { pill: "info", label: "구매 처리 중",  tone: "waiting", mark: "…" },
  consumed:      { pill: "idle", label: "사용됨",        tone: "",        mark: "✓" },
  cancelled:     { pill: "idle", label: "취소됨",        tone: "",        mark: "×" },
  expired:       { pill: "err",  label: "만료",          tone: "err",     mark: "!" },
  reset:         { pill: "err",  label: "초기화됨",      tone: "err",     mark: "!" },
};

const QUEUE_NOTICES = {
  JOIN_UNCONFIRMED: "등록 결과를 확인하지 못했습니다. 다시 누르면 같은 등록 요청을 한 번 더 보냅니다.",
  CANCEL_UNCONFIRMED: "취소 결과를 확인하지 못했습니다. 아래 상태는 서버에서 다시 읽은 것입니다.",
  ADMISSION_RESET: "대기열이 초기화되어 등록되지 않았습니다. 다시 등록해 주세요.",
  ADMISSION_QUEUE_FULL: "대기열이 가득 찼습니다. 잠시 뒤 다시 등록해 주세요.",
  ADMISSION_RATE_LIMITED: "요청 한도를 넘었습니다. 잠시 뒤 다시 시도해 주세요.",
  ADMISSION_IN_PROGRESS: "구매를 처리하는 중이라 취소할 수 없습니다.",
  ADMISSION_ALREADY_CONSUMED: "이미 사용된 입장 자격입니다. 대기 취소는 구매 취소가 아닙니다.",
  ACTIVE_ADMISSION_EXISTS: "이미 진행 중인 등록이 있어 그 상태를 표시합니다.",
};

const QUEUE_PROBLEMS = {
  network: "서버에 연결하지 못했습니다.",
  unavailable: "대기열이 일시적으로 응답하지 않습니다.",
  "rate-limited": "요청이 많아 잠시 기다립니다.",
  unauthenticated: "Live demo 세션이 유효하지 않아 상태를 읽지 못했습니다.",
  invalid: "요청이 거절되었습니다.",
};

// What needs the user now is announced at once.
const QUEUE_ALERTS = {
  admitted: "입장했습니다. 남은 시간 안에 Step 3에서 예약을 시작하세요.",
  expired: "대기 또는 입장 시간이 지나 만료되었습니다.",
  reset: "대기열이 초기화되었습니다. 계속하려면 다시 등록해야 합니다.",
};

// Positions at which a waiting user is told again. Announcing every poll would be noise.
const QUEUE_MARKS = [1, 2, 3, 5, 10, 20, 50, 100];

function queueConsumedText(outcome) {
  if (outcome?.kind === "reservation")
    return ["입장 자격을 예약에 사용했습니다.", `reservation ${fmtShort(outcome.resourceId || "", 8)}`];
  if (outcome?.kind === "direct-checkout")
    return ["입장 자격을 주문에 사용했습니다.", `order ${fmtShort(outcome.resourceId || "", 8)}`];
  if (outcome?.kind === "rejected")
    return [`구매가 거절되었습니다 (${outcome.code || "사유 없음"}).`,
            "같은 요청은 같은 답을 받습니다. 다시 시도하려면 새로 등록해야 합니다."];
  return ["입장 자격을 사용했습니다.", "구매 결과는 구매 응답이 기준입니다."];
}

const QueueCard = ({ state, actions }) => {
  const { admission: view, queueEnabled, pollMode, queueUserId, liveSessionStatus, reservation, expandedSteps } = state;
  const phase = view?.phase || "loading";
  const entry = view?.admission || null;
  const problem = view?.problem || null;
  const purchase = view?.purchase || null;
  const meta = QUEUE_PHASES[phase] || QUEUE_PHASES.loading;

  const [confirming, setConfirming] = useStateF(false);
  const [, setTick] = useStateF(0);
  const [heard, setHeard] = useStateF(null);

  // The countdowns read the local monotonic clock twice a second. They send nothing.
  const ticking = view?.deadlineAt != null || problem?.retryAt != null;
  useEffectF(() => {
    if (!ticking) return undefined;
    const id = setInterval(() => setTick(n => n + 1), 500);
    return () => clearInterval(id);
  }, [ticking]);
  const secondsUntil = (at) => at == null ? null : Math.max(0, Math.ceil((at - performance.now()) / 1000));
  const left = secondsUntil(view?.deadlineAt);
  const retryIn = secondsUntil(problem?.retryAt);

  useEffectF(() => { setConfirming(false); }, [phase]);

  // Screen readers hear the position at a few marks, not on every poll: `heard` is the
  // position at the last mark, read again when a problem ends. Both texts follow the state,
  // so none outlives what it describes.
  const mark = phase === "waiting" && entry?.position ? (QUEUE_MARKS.find(m => entry.position <= m) || 0) : null;
  useEffectF(() => { setHeard(mark === null ? null : entry.position); }, [mark, !problem]);
  const spokenStatus = problem ? (QUEUE_PROBLEMS[problem.kind] || QUEUE_PROBLEMS.invalid)
    : phase === "waiting" && heard != null ? `대기 ${heard}번째입니다.`
    : phase === "cancelled" ? "대기를 취소했습니다."
    : "";
  const spokenAlert = purchase?.status === "unconfirmed"
    ? "구매 결과를 확인하지 못했습니다. 새로 등록하지 말고 같은 요청으로 다시 확인하세요."
    : QUEUE_ALERTS[phase] || "";

  // A user who is looking at another tab sees the admission in the tab title, and the
  // reservation step opens so that the 30 s are not spent finding it.
  useEffectF(() => {
    if (phase !== "admitted") return undefined;
    const title = document.title;
    document.title = "입장했습니다 · PeakPass";
    actions.gotoStep?.(3);
    return () => { document.title = title; };
  }, [phase]);

  const outcome = entry?.outcome || null;
  const [title, sub] = {
    loading: ["대기열 상태를 확인하고 있습니다.", "상태는 항상 서버에서 다시 읽습니다."],
    "not-enabled": ["이 이벤트는 대기열 없이 바로 예약할 수 있습니다.", "Step 3을 그대로 실행하면 됩니다."],
    "not-joined": ["아직 대기열에 등록하지 않았습니다.", "등록하면 접수한 순서대로 입장합니다."],
    waiting: [`현재 ${entry?.position ?? "—"}번째로 대기 중입니다.`,
              `접수 순번 ${entry?.sequence ?? "—"} · 입장하면 이 화면과 탭 제목으로 알려 드립니다. 확인이 2분 넘게 끊기면 대기가 만료됩니다.`],
    admitted: ["입장했습니다.", "남은 시간 안에 아래 Step 3에서 예약을 시작하세요. 시간이 지나면 입장 자격이 만료됩니다."],
    processing: ["구매 요청을 처리하고 있습니다.",
                 "결과는 구매 응답으로 확정됩니다. 대기열에 반영되기를 기다리는 표시이며 실패가 아닙니다."],
    consumed: queueConsumedText(outcome),
    cancelled: ["대기를 취소했습니다.", "다시 등록하면 맨 뒤 순번을 받습니다."],
    expired: ["대기 또는 입장 시간이 지나 만료되었습니다.", "자동으로 다시 등록하지 않습니다. 계속하려면 다시 등록해 주세요."],
    reset: ["대기열이 초기화되었습니다.", "이전 순번은 복원되지 않습니다. 계속하려면 다시 등록해 주세요."],
  }[phase] || ["대기열 상태를 확인하고 있습니다.", ""];

  const joinable = ["not-joined", "reset", "consumed", "cancelled", "expired"].includes(phase);
  const cancellable = phase === "waiting" || phase === "admitted";
  // A join or cancel waits out an error wait of the queue API, and an open purchase comes first.
  const held = !!view?.busy || !!purchase || (retryIn != null && retryIn > 0);
  const statusLabel = (
    <span className={`status-pill ${queueEnabled ? meta.pill : "idle"}`}>
      <span className="dot"/>{queueEnabled ? meta.label : "이벤트 미선택"}
    </span>
  );

  return (
    <StepCard
      n="Q" title="입장 대기열"
      endpoint="/events/:eventId/admissions/me" method="GET"
      status={!queueEnabled ? "idle" : phase === "admitted" ? "done" : phase === "expired" ? "error" : "idle"}
      statusLabel={statusLabel}
      active={queueEnabled && (phase === "waiting" || phase === "admitted")}
      expanded={expandedSteps?.sq !== false}
      onToggle={() => actions.toggleStep("sq")}
    >
      <div className="queue-lead">
        대기열을 쓰는 이벤트는 여기서 입장한 뒤에만 예약할 수 있습니다. 순번과 입장 여부는 항상 서버에서 다시 읽고, 브라우저에 저장한 값으로 판단하지 않습니다.
      </div>

      {!queueEnabled ? (
        <div className="queue-banner">
          <div className="qb-mark" aria-hidden="true">—</div>
          <div>
            <div className="qb-title">이벤트를 먼저 선택하세요.</div>
            <div className="qb-sub">Step 1에서 Live API의 이벤트를 불러와 선택하면 그 이벤트의 대기열 상태를 확인합니다.</div>
          </div>
        </div>
      ) : !view ? (
        <div className={`queue-banner ${liveSessionStatus === "error" ? "err" : ""}`}>
          <div className="qb-mark" aria-hidden="true">{liveSessionStatus === "error" ? "!" : "…"}</div>
          <div>
            <div className="qb-title">
              {liveSessionStatus === "error" ? "Live demo 세션을 시작하지 못했습니다." : "Live demo 세션을 준비하고 있습니다."}
            </div>
            <div className="qb-sub">
              {liveSessionStatus === "error"
                ? "API 주소와 서버의 ENABLE_DEMO_SESSION 설정을 확인한 뒤 다시 시도하세요."
                : "세션이 준비되면 대기열 상태를 서버에서 읽습니다."}
            </div>
          </div>
          {liveSessionStatus === "error" && (
            <button type="button" className="btn btn-secondary" onClick={actions.recheckQueue}>다시 시도</button>
          )}
        </div>
      ) : (
        <>
          <div className="queue-hint" style={{marginTop:10}}>
            Live demo는 <b>고정 사용자 1명</b>(<code style={{fontFamily:"var(--font-mono)"}}>{fmtShort(queueUserId, 8)}</code>)으로 동작합니다.
            같은 사용자로 열린 다른 탭이나 다른 사람의 등록·취소·구매는 다음 상태 확인 때 이 화면에도 나타납니다.
          </div>

          <div className="queue-mode" role="group" aria-label="상태 확인 주기">
            <span className="field-label">Polling</span>
            {[["adaptive", "Adaptive 1–5s + jitter"], ["fixed", "Fixed 1s"]].map(([value, label]) => (
              <button type="button" key={value} className="queue-mode-option"
                      aria-pressed={pollMode === value} onClick={() => actions.setPollMode(value)}>
                {label}
              </button>
            ))}
            <span className="queue-hint">두 방식은 같은 API와 같은 입장 자격을 씁니다. 숨겨진 탭은 둘 다 15초 간격입니다.</span>
          </div>

          <div className={`queue-banner ${meta.tone}`}>
            <div className="qb-mark" aria-hidden="true">{meta.mark}</div>
            <div>
              <div className="qb-title">{title}</div>
              <div className="qb-sub">{sub}</div>
            </div>
            {phase === "waiting" && entry?.position != null && (
              <div className="qb-stat"><div className="n">{entry.position}</div><div className="l">번째</div></div>
            )}
            {phase === "admitted" && left != null && (
              <div className="qb-stat"><div className="n">{left}</div><div className="l">초 남음</div></div>
            )}
          </div>

          {problem && (
            <div className="queue-note err">
              {QUEUE_PROBLEMS[problem.kind] || QUEUE_PROBLEMS.invalid}
              {problem.code ? ` (${problem.code})` : ""}
              {retryIn != null && (retryIn > 0 ? ` ${retryIn}초 뒤 자동으로 다시 확인합니다.` : " 다시 확인하는 중입니다.")}
              {retryIn != null && entry ? " 등록 정보는 그대로 둡니다." : ""}
              {retryIn == null && (
                <button type="button" className="btn btn-ghost" onClick={actions.recheckQueue}>다시 확인</button>
              )}
            </div>
          )}

          {view.notice && (
            <div className="queue-note">
              {QUEUE_NOTICES[view.notice] || `요청이 처리되지 않았습니다 (${view.notice}).`}
            </div>
          )}

          {purchase && purchase.status !== "unconfirmed" && (
            <div className="queue-note">
              구매 요청을 보내는 중입니다.
              {purchase.attempts > 1 && ` 결과를 확인하지 못해 같은 요청을 다시 보내고 있습니다 (${purchase.attempts}번째).`}
            </div>
          )}
          {purchase?.status === "unconfirmed" && (
            <div className="queue-note err">
              {purchase.restored ? "이전에 보낸 구매 요청의 결과가 확인되지 않았습니다. " : "구매 결과를 아직 확인하지 못했습니다. "}
              새로 등록하지 말고 같은 요청으로 다시 확인하세요.
              <button type="button" className="btn btn-secondary" style={{marginLeft:10}} onClick={actions.retryPurchase}>
                같은 요청으로 다시 확인
              </button>
            </div>
          )}

          <div className="btn-row" style={{marginTop:12}}>
            {joinable && (
              <button type="button" className="btn btn-accent" onClick={actions.joinQueue} disabled={held}>
                {view.busy === "join" ? "등록 중…" : phase === "not-joined" ? "대기열 등록" : "다시 등록"}
              </button>
            )}
            {/* One button opens and closes the confirmation, so the keyboard focus stays on it. */}
            {cancellable && (
              <button type="button" className="btn btn-secondary" aria-expanded={confirming}
                      onClick={() => setConfirming(open => !open)} disabled={held && !confirming}>
                {view.busy === "cancel" ? "취소 중…" : confirming ? "돌아가기" : "대기 취소"}
              </button>
            )}
            {cancellable && confirming && (
              <>
                <span className="queue-confirm" id="queue-cancel-confirm">취소하면 순번을 잃습니다. 취소할까요?</span>
                <button type="button" className="btn btn-danger" aria-describedby="queue-cancel-confirm" disabled={held}
                        onClick={() => { setConfirming(false); actions.cancelQueue(); }}>
                  취소 확정
                </button>
              </>
            )}
            {phase === "consumed" && outcome?.kind === "reservation" && !reservation && (
              <button type="button" className="btn btn-secondary" onClick={actions.loadReservation}>예약 불러오기</button>
            )}
          </div>
        </>
      )}

      <div className="sr-only" role="status" aria-live="polite">{spokenStatus}</div>
      <div className="sr-only" role="alert">{spokenAlert}</div>
    </StepCard>
  );
};

// What the purchase answered, in words. Codes are from admission-v1 §3 and the purchase paths.
const PURCHASE_ERRORS = {
  ADMISSION_INVALID_INPUT: "입장 자격이 필요하거나 요청 형식이 맞지 않습니다. 입장 대기열의 상태를 확인하세요.",
  UNAUTHENTICATED: "인증이 필요합니다. Live demo 세션을 다시 시작한 뒤 시도하세요.",
  ADMISSION_NOT_FOUND: "이 입장 자격은 사용할 수 없습니다.",
  ADMISSION_NOT_READY: "아직 입장 전입니다. 대기열에서 입장을 기다리세요.",
  ADMISSION_REQUEST_MISMATCH: "이 입장 자격은 다른 구매 요청에 이미 묶여 있습니다.",
  ADMISSION_EXPIRED: "입장 자격이 만료되었습니다. 이 요청으로 예약된 것은 없습니다. 계속하려면 대기열에 다시 등록하세요.",
  ADMISSION_CANCELLED: "취소된 입장 자격입니다. 이 요청으로 예약된 것은 없습니다. 계속하려면 대기열에 다시 등록하세요.",
  ADMISSION_RESET: "대기열이 초기화되었습니다. 이 요청으로 예약된 것은 없습니다. 계속하려면 대기열에 다시 등록하세요.",
  INSUFFICIENT_INVENTORY: "좌석이 부족해 예약이 거절되었습니다. 다시 시도하려면 대기열에 새로 등록해야 합니다.",
};

// ---------- The 7-step flow ----------
const DemoFlow = ({ state, actions }) => {
  const {
    mode, events, selectedEventId, selectedTierId, userId, quantity,
    liveSessionUserId, liveSessionExpiresAt, liveSessionStatus, liveSessionError,
    reservation, order, settlement, duplicateReplay, duplicateSemantic,
    ticketByCode, stepStatus, stepTiming, requests, activeStep, expandedSteps,
    checkoutIdemKey, settlementIdemKey, providerTxnId,
    dupBusy = { A: false, B: false } // [FIX] per-button busy flags for Step 6
  } = state;

  const selectedEvent = events?.find(e => e.id === selectedEventId);
  const selectedTier = selectedEvent?.pricing?.find(p => p.tierId === selectedTierId);
  const orderStatus = order?.order?.status;
  const paymentStatus = settlement?.paymentStatus || settlement?.order?.paymentStatus;
  const settlementOrderStatus = String(settlement?.order?.status || "—").toUpperCase();
  const needsReconciliation = settlementOrderStatus === "EXPIRED" && String(paymentStatus).toUpperCase() === "SETTLED";
  const tickets = settlement?.tickets || order?.tickets || [];
  const isLiveDemo = mode === "live";
  const liveSessionReady = !isLiveDemo || !!liveSessionUserId;

  // Admission queue (live mode). An event that uses the queue can be reserved only while the
  // entry is admitted, and the reservation then carries the admission.
  const queue = state.admission || null;
  const queueEnabled = !!state.queueEnabled;
  const queueOpen = !queueEnabled || queue?.phase === "not-enabled" || queue?.phase === "admitted";
  const purchaseOpen = !!queue?.purchase;
  // A purchase whose outcome is unknown is neither running nor failed.
  const purchaseUnconfirmed = queue?.purchase?.status === "unconfirmed";
  const purchaseError = state.purchaseError || null;
  const admissionFields = queueEnabled && queue?.phase === "admitted" && queue.admission
    ? { admissionId: queue.admission.admissionId, admissionEpoch: queue.admission.epoch }
    : null;

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
              <button className="btn btn-warn" onClick={actions.runAll} disabled={isLiveDemo}>
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
                      // [FIX] defensive guards — backend may return events with missing
                      // totalSeats / availableSeats / pricing fields. Without these checks
                      // a single undefined field crashes the entire DemoFlow render tree.
                      const total = Number(ev?.totalSeats) || 0;
                      const available = Number(ev?.availableSeats) || 0;
                      const pricingCount = Array.isArray(ev?.pricing) ? ev.pricing.length : 0;
                      const ratio = total > 0 ? available / total : 0;
                      const cls = ratio < 0.1 ? "crit" : ratio < 0.3 ? "low" : "";
                      return (
                        <button type="button" key={ev.id}
                             className={`event-card ${selectedEventId === ev.id ? "selected" : ""}`}
                             aria-pressed={selectedEventId === ev.id}
                             onClick={() => actions.selectEvent(ev.id)}>
                          <span className="event-date">{ev?.startsAt ? fmtDate(ev.startsAt) : "—"}</span>
                          <span className="event-title">{ev?.name || "(이름 없음)"}</span>
                          <span className="event-meta">
                            <span>{available.toLocaleString()} / {total.toLocaleString()} 좌석</span>
                            <span>{pricingCount} tiers</span>
                          </span>
                          <span className="capacity-bar"><span className={`fill ${cls}`} style={{width: `${ratio * 100}%`}}/></span>
                        </button>
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
                    {(selectedEvent.pricing || []).map(p => (
                      <button type="button" key={p.tierId}
                           className={`tier-card ${selectedTierId === p.tierId ? "selected" : ""}`}
                           aria-pressed={selectedTierId === p.tierId}
                           onClick={() => actions.selectTier(p.tierId)}>
                        <span className="tier-name">{p?.name || "(no name)"}</span>
                        <span className="tier-price">{fmtKRW(p?.price)}</span>
                        <span className="tier-sub">정원 {(Number(p?.seats) || 0).toLocaleString()}석</span>
                      </button>
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
                    {mode === "live" ? (
                      <>
                        <div className="field-label">Live demo session</div>
                        <input className="input small" readOnly value={liveSessionUserId || "Issued automatically at Step 3"}/>
                        <div className="field-hint">
                          {liveSessionStatus === "active"
                            ? `Fixed demo user session active until ${fmtDate(liveSessionExpiresAt)}.`
                            : "The fixed demo user and a short-lived session are issued automatically. No user ID or token input is required."}
                          {liveSessionError && <span style={{display:"block", color:"var(--red)", marginTop:4}}>{liveSessionError}</span>}
                        </div>
                      </>
                    ) : <>
                    <div className="field-label">User ID (seed)</div>
                    <input className="input small" value={userId} onChange={e => actions.setUserId(e.target.value)}/>
                    <div className="field-hint">
                      <Icon name="warn" size={11}/> 로컬에서는 <code style={{fontFamily:"var(--font-mono)"}}>npm run seed</code> 로그 또는 DB 조회로 seed userId를 확인해 입력하세요. 프론트는 백엔드 인증 구조를 변경하지 않습니다.
                    </div>
                    </>}
                  </div>
                </div>

                <div className="btn-row" style={{marginTop:14}}>
                  <button className="btn btn-primary" disabled={!selectedTierId || (mode === "mock" && !userId)} onClick={() => { actions.markStepDone("s2"); actions.gotoStep(3); }}>
                    <Icon name="check" size={12}/> 선택 확정 · 다음 단계로
                  </button>
                </div>
              </>
            )}
          </StepCard>

          {/* Admission queue: live mode only. Mock mode has no queue. */}
          {isLiveDemo && <QueueCard state={state} actions={actions}/>}

          {/* STEP 3 */}
          <StepCard
            n="3" title="Reservation Hold 생성"
            endpoint="/reservations" method="POST"
            status={purchaseUnconfirmed ? "idle" : stepStatus.s3}
            statusLabel={purchaseUnconfirmed
              ? <span className="status-pill info"><span className="dot"/>결과 미확인</span>
              : undefined}
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
                <JsonView value={selectedEvent && selectedTier && (userId || mode === "live") ? {
                  eventId: selectedEvent.id,
                  userId: userId || "Issued by live demo session",
                  quantity,
                  tierId: selectedTier.tierId,
                  ...(admissionFields || {})
                } : null}/>
              </div>
              <div>
                <div className="field-label" style={{marginBottom:4}}>Response</div>
                <JsonView value={reservation} emptyLabel="아직 실행되지 않음"/>
              </div>
            </div>
            <div className="btn-row" style={{marginTop:12}}>
              <button className="btn btn-danger" onClick={actions.step3}
                      disabled={!selectedTier || (mode === "mock" && !userId) || stepStatus.s3 === "running" || !queueOpen || purchaseOpen}>
                <Icon name="play" size={11}/> POST /reservations
              </button>
            </div>
            {!queueOpen && !reservation && (
              <div className="queue-hint" style={{marginTop:8}}>
                <Icon name="warn" size={11}/> 대기열을 쓰는 이벤트일 수 있습니다. 위 <b>입장 대기열</b>에서 입장한 뒤 실행할 수 있습니다.
              </div>
            )}
            {purchaseError && (
              <div className="result-banner err" role="alert">
                <div className="rb-icon">!</div>
                <div>
                  <div className="rb-title">예약이 처리되지 않았습니다 · {purchaseError.status} {purchaseError.code || ""}</div>
                  <div className="rb-sub">{PURCHASE_ERRORS[purchaseError.code] || purchaseError.message || "요청이 거절되었습니다."}</div>
                </div>
              </div>
            )}
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
            endpoint={isLiveDemo ? "/demo/settlement" : "/webhooks/payments/settlement"} method="POST"
            status={stepStatus.s5}
            active={activeStep === 5}
            expanded={expandedSteps.s5}
            onToggle={() => actions.toggleStep("s5")}
            timing={stepTiming.s5}
          >
            <div style={{fontSize:13, color:"var(--ink-2)"}}>
              PG사가 보낸 정산 webhook을 처리합니다. 이 시점에만 <code style={{fontFamily:"var(--font-mono)"}}>tickets</code>가 생성됩니다.
            </div>
            {isLiveDemo && (
              <div className="field-hint" style={{marginTop:8}}>
                Live demo uses the authenticated demo settlement endpoint. The real webhook remains HMAC-protected and its signing secret never reaches the browser.
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
                <JsonView value={order ? (isLiveDemo ? {
                  orderId: order.order?.id
                } : {
                  orderId: order.order?.id,
                  providerTransactionId: providerTxnId,
                  status: "settled"
                }) : null}/>
              </div>
              <div>
                <div className="field-label" style={{marginBottom:4}}>Response</div>
                <JsonView value={settlement} emptyLabel="아직 실행되지 않음"/>
              </div>
            </div>
            <div className="btn-row" style={{marginTop:12}}>
              <button className="btn btn-danger" onClick={actions.step5}
                      disabled={!order || stepStatus.s5 === "running" || !liveSessionReady}>
                <Icon name="play" size={11}/> POST {isLiveDemo ? "/demo/settlement" : "/webhooks/payments/settlement"}
              </button>
            </div>
            {settlement && (
              <>
                <div className={`result-banner ${settlementOrderStatus === "PAID" ? "paid" : "pending"}`}>
                  <div className="rb-icon"><Icon name="check" size={16}/></div>
                  <div>
                    <div className="rb-title">order: <span>{settlementOrderStatus}</span> · payment: <span>{String(paymentStatus || "—").toUpperCase()}</span> · ticket: <span>{tickets.length > 0 ? "ISSUED" : "NONE"}</span></div>
                    <div className="rb-sub">{needsReconciliation ? "만료된 주문의 결제가 확인되었습니다. 확인·환불 조치 필요." : tickets.length > 0 ? "결제 확인 후 발급된 티켓입니다." : "발급된 티켓이 없습니다."}</div>
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
                  {isLiveDemo
                    ? <>동일 <code style={{fontFamily:"var(--font-mono)"}}>Idempotency-Key</code>와 동일 주문을 다시 전송합니다. 인증된 demo settlement 경로가 기존 paid order와 티켓을 반환하며, 브라우저는 webhook 서명이나 비밀값을 전송하지 않습니다.</>
                    : <>동일 <code style={{fontFamily:"var(--font-mono)"}}>Idempotency-Key</code>와 동일 body. Redis의 idempotency cache가 저장해 둔 기존 응답을 그대로 반환합니다.</>}
                </div>
                <button className="btn btn-secondary" onClick={actions.runDupReplay}
                        disabled={!settlement || dupBusy.A || !liveSessionReady}>
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
                  {isLiveDemo
                    ? <><b>새로운</b> Idempotency-Key와 동일 <code style={{fontFamily:"var(--font-mono)"}}>orderId</code>를 전송합니다. 서버가 같은 provider transaction ID를 결정론적으로 생성하므로 payment domain service가 기존 티켓만 반환합니다.</>
                    : <><b>새로운</b> Idempotency-Key지만 동일 <code style={{fontFamily:"var(--font-mono)"}}>orderId / providerTransactionId</code>. Redis 캐시를 지나가더라도 DB <code style={{fontFamily:"var(--font-mono)"}}>UNIQUE(provider_txn_id)</code> 위반으로 방어됩니다.</>}
                </div>
                <button className="btn btn-secondary" onClick={actions.runDupSemantic}
                        disabled={!settlement || dupBusy.B || !liveSessionReady}>
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
    ["queue.phase", state.admission?.phase || "—"],
    ["queue.position", state.admission?.admission?.position ?? "—"],
    ["queue.pollMode", state.queueEnabled ? state.pollMode : "—"],
    ["queue.polls", state.admission?.polls ?? "—"],
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
    { b: "ADMIT", t: "대기열을 쓰는 이벤트는 입장 자격(admissionId · admissionEpoch)을 예약 요청에 함께 보냅니다." },
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
            <button type="button" className="le-head" onClick={() => toggle(i)} aria-expanded={openIdx.has(i)}>
              <span className={`method ${r.method}`}>{r.method === "GQL" ? "GQL" : r.method}</span>
              <span style={{fontFamily:"var(--font-mono)", fontSize:11, color:"var(--muted)"}}>#{String(i+1).padStart(2,"0")}</span>
              <span className="url">{r.url}{r.idemKey ? ` · Idem: ${fmtShort(r.idemKey, 10)}` : ""}</span>
              <span className={`status s${String(r.status)[0]}`}>{r.status}</span>
              <span className="elapsed">{r.elapsed}ms</span>
              <span className="chev" style={{transform: openIdx.has(i) ? "rotate(180deg)" : "none", transition:"transform 0.15s"}}>
                <Icon name="chev-d" size={12}/>
              </span>
            </button>
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

Object.assign(window, { DemoFlow, StateInspector, ExplanationNotes, RequestLog, TicketCard, StepCard, QueueCard });
