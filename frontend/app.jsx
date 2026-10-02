// Main App — state, actions, mock/live API layer, orchestration

const { useState: useS, useEffect: useE, useMemo: useM, useRef: useR, useCallback: useC } = React;

// ---------- API layer ----------
async function callLive(apiBase, method, path, body, headers = {}, isGraphQL = false, signal) {
  const t0 = performance.now();
  try {
    const base = apiBase.replace(/\/+$/, "");
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...headers },
      body: body ? JSON.stringify(body) : undefined,
      signal,
    });
    const elapsed = Math.round(performance.now() - t0);
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = text; }
    // A cross-origin page can read Retry-After only when the server exposes it. The admission
    // error body carries the same wait as nextPollAfterMs, so nothing depends on this header.
    const retryAfterMs = window.PeakPassAdmission.parseRetryAfter(res.headers.get("Retry-After"));
    return { ok: res.ok, status: res.status, elapsed, data: json, retryAfterMs };
  } catch (e) {
    const elapsed = Math.round(performance.now() - t0);
    return { ok: false, status: 0, elapsed, data: { error: "Network error", message: e.message } };
  }
}

// Mock server logic — mirrors the real backend contract
function createMockServer() {
  const idempCache = new Map();      // key -> response
  const orders = new Map();
  const tickets = new Map();         // orderId -> tickets[]
  const settledTxns = new Set();     // provider_txn_id

  const delay = () => new Promise(r => setTimeout(r, 180 + Math.random() * 260));

  async function graphql(query, variables) {
    await delay();
    if (query.includes("events(")) {
      return { ok: true, status: 200, data: { data: { events: window.MOCK_EVENTS } } };
    }
    if (query.includes("ticketByCode")) {
      for (const list of tickets.values()) {
        const t = list.find(x => x.ticketNumber === variables.code);
        if (t) {
          return {
            ok: true, status: 200,
            data: { data: { ticketByCode: {
              valid: t.status === "active" || t.status === "ISSUED",
              status: t.status,
              ticketNumber: t.ticketNumber,
              eventName: t.eventName,
              startsAt: t.startsAt,
              endsAt: t.endsAt
            } } }
          };
        }
      }
      return { ok: true, status: 200, data: { data: { ticketByCode: {
        valid: false,
        status: "not_found",
        ticketNumber: variables.code,
        eventName: null,
        startsAt: null,
        endsAt: null
      } } } };
    }
    return { ok: true, status: 200, data: { data: {} } };
  }

  async function reservations(body) {
    await delay();
    const id = "rsv_" + Math.random().toString(36).slice(2, 14).toUpperCase();
    const expires = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    return { ok: true, status: 201, data: {
      id, status: "HELD", eventId: body.eventId, userId: body.userId,
      tierId: body.tierId, quantity: body.quantity, expiresAt: expires,
      heldAt: new Date().toISOString()
    } };
  }

  async function checkouts(body, idemKey) {
    await delay();
    if (idempCache.has("checkout:" + idemKey)) {
      return { ok: true, status: 200, data: idempCache.get("checkout:" + idemKey), replayed: true };
    }
    const event = window.MOCK_EVENTS.find(e => e.id === body.eventId);
    const tier = event?.pricing.find(p => p.tierId === body.tierId);
    const orderId = "ord_" + Math.random().toString(36).slice(2, 14).toUpperCase();
    const total = (tier?.price || 0) * body.quantity;
    const order = {
      id: orderId, userId: body.userId, eventId: body.eventId, tierId: body.tierId,
      quantity: body.quantity, totalAmount: total,
      status: "PENDING", paymentStatus: "PENDING",
      reservationId: body.reservationId, createdAt: new Date().toISOString()
    };
    orders.set(orderId, order);
    const resp = { order, tickets: [], _meta: { ticketsIssued: false, reason: "awaiting_settlement" } };
    idempCache.set("checkout:" + idemKey, resp);
    return { ok: true, status: 201, data: resp };
  }

  async function settlement(body, idemKey) {
    await delay();
    const cacheKey = "settle:" + idemKey;
    if (idempCache.has(cacheKey)) {
      const cached = idempCache.get(cacheKey);
      return { ok: true, status: 200, data: { ...cached, duplicate: true, _meta: { source: "redis_idempotency_cache" } }, replayed: true };
    }
    if (settledTxns.has(body.providerTransactionId)) {
      // semantic duplicate — DB unique catches it
      const existing = Array.from(orders.values()).find(o => o.id === body.orderId);
      const existingTickets = tickets.get(body.orderId) || [];
      const resp = { order: existing, paymentStatus: "SETTLED", tickets: existingTickets, duplicate: true, _meta: { guard: "payments.provider_txn_id UNIQUE" } };
      idempCache.set(cacheKey, resp);
      return { ok: true, status: 200, data: resp };
    }
    const order = orders.get(body.orderId);
    if (!order) return { ok: false, status: 404, data: { error: "ORDER_NOT_FOUND" } };

    order.status = "PAID";
    order.paymentStatus = "SETTLED";
    const event = window.MOCK_EVENTS.find(e => e.id === order.eventId);
    const tier = event?.pricing.find(p => p.tierId === order.tierId);
    const issued = [];
    for (let i = 0; i < order.quantity; i++) {
      const code = "PP-" +
        Math.random().toString(36).slice(2, 6).toUpperCase() + "-" +
        Math.random().toString(36).slice(2, 6).toUpperCase();
      issued.push({
        id: "tk_" + Math.random().toString(36).slice(2, 12).toUpperCase(),
        ticketNumber: code,
        orderId: order.id, eventId: order.eventId, eventName: event?.name,
        startsAt: event?.startsAt, endsAt: event?.endsAt,
        tier: tier?.name, seat: `${String.fromCharCode(65 + i)}-${10 + i}`,
        status: "ISSUED", createdAt: new Date().toISOString()
      });
    }
    tickets.set(order.id, issued);
    settledTxns.add(body.providerTransactionId);

    const resp = { order, paymentStatus: "SETTLED", tickets: issued, duplicate: false };
    idempCache.set(cacheKey, resp);
    return { ok: true, status: 200, data: resp };
  }

  async function health() { await delay(); return { ok: true, status: 200, data: { status: "ok", uptime: 4281, version: "1.4.0", node: "20.11.1" } }; }
  async function ready()  { await delay(); return { ok: true, status: 200, data: { status: "ready", timestamp: new Date().toISOString(), checks: { postgres: true, redis: true } } }; }

  return { graphql, reservations, checkouts, settlement, health, ready };
}

const mockServer = createMockServer();

// ---------- Admission queue (live mode only) ----------
// The queue has no mock: a simulated wait would look like a measurement. Mock mode renders no
// queue card and writes nothing to the trace.
const isUuid = (value) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value || "");
const pageParams = new URLSearchParams(window.location.search);
const POLL_MODES = ["adaptive", "fixed"];

// `?poll=fixed|adaptive` pins the mode of a measured run; otherwise the stored choice applies.
function initialPollMode() {
  const fromUrl = pageParams.get("poll");
  if (POLL_MODES.includes(fromUrl)) return fromUrl;
  const saved = localStorage.getItem("pp_poll_mode");
  return POLL_MODES.includes(saved) ? saved : "adaptive";
}

// What this page did, for the measurements of admission-v1 §7. `runId` comes from `?run=`,
// `tabId` only labels this page load; neither is sent to the server.
const admissionTrace = window.PeakPassAdmission.createTrace({
  limit: 5000,
  meta: {
    runId: pageParams.get("run") || "local",
    tabId: window.uuid(),
    startedAt: new Date().toISOString(),
  },
});
window.PeakPassAdmissionTrace = { snapshot: () => admissionTrace.snapshot() };

// Marks an admission whose first recognition was recorded, shared by the tabs of this browser
// profile so that a reload or a second tab does not count it again. It decides nothing else.
// The key is (epoch, admissionId) without the run: an admission id is unique, the sample
// belongs to the run of the page that recorded it, and a key with the run made the next run
// record an admission that had been recognized as missed.
const seenAdmissions = {
  read() {
    try { return JSON.parse(localStorage.getItem("pp_admission_seen")) || []; } catch { return []; }
  },
  has(key) { return this.read().includes(key); },
  add(key) {
    localStorage.setItem("pp_admission_seen", JSON.stringify([...this.read(), key].slice(-50)));
  },
};

// The template of a purchase whose outcome is still open, so that the same request can be
// repeated after a reload. It holds no token and proves nothing: the server authenticates the
// JWT and answers 404 for an admission of another user.
const pendingPurchases = {
  get: (key) => sessionStorage.getItem(`pp_pending_purchase:${key}`),
  set: (key, value) => sessionStorage.setItem(`pp_pending_purchase:${key}`, value),
  remove: (key) => sessionStorage.removeItem(`pp_pending_purchase:${key}`),
};

const pageVisibility = {
  hidden: () => document.visibilityState === "hidden",
  subscribe(listener) {
    document.addEventListener("visibilitychange", listener);
    return () => document.removeEventListener("visibilitychange", listener);
  },
};

// ---------- Main App ----------
function defaultApiBase() {
  const saved = localStorage.getItem("pp_api_base");
  if (saved) return saved;
  if (window.location.protocol === "http:" || window.location.protocol === "https:") {
    return window.location.origin;
  }
  return "http://localhost:3000";
}

const App = () => {
  const [apiBase, setApiBase] = useS(defaultApiBase);
  const [mode, setMode] = useS(() => localStorage.getItem("pp_mode") || "mock");
  const [userId, setUserId] = useS(() => localStorage.getItem("pp_user_id") || window.SEED_USER_ID);
  const [liveSession, setLiveSession] = useS(null);
  const [liveSessionStatus, setLiveSessionStatus] = useS("idle");
  const [liveSessionError, setLiveSessionError] = useS("");
  const liveSessionRef = useR(null);
  const liveSessionInFlightRef = useR(null);

  const [events, setEvents] = useS(null);
  const [selectedEventId, setSelectedEventId] = useS(() => localStorage.getItem("pp_event_id") || null);
  const [selectedTierId, setSelectedTierId] = useS(() => localStorage.getItem("pp_tier_id") || null);
  const [quantity, setQuantity] = useS(2);

  const [reservation, setReservation] = useS(null);
  const [order, setOrder] = useS(null);
  const [settlement, setSettlement] = useS(null);
  const [duplicateReplay, setDuplicateReplay] = useS(null);
  const [duplicateSemantic, setDuplicateSemantic] = useS(null);
  const [ticketByCode, setTicketByCode] = useS(null);
  const [lookupCode, setLookupCode] = useS("");

  const [health, setHealth] = useS(null);
  const [ready, setReady] = useS(null);

  const [checkoutIdemKey, setCheckoutIdemKey] = useS("");
  const [settlementIdemKey, setSettlementIdemKey] = useS("");
  const [providerTxnId, setProviderTxnId] = useS("");

  const [stepStatus, setStepStatus] = useS({ s1:"idle",s2:"idle",s3:"idle",s4:"idle",s5:"idle",s6:"idle",s7:"idle" });
  const [stepTiming, setStepTiming] = useS({});
  const [activeStep, setActiveStep] = useS(1);
  const [expandedSteps, setExpandedSteps] = useS({ s1: true, s2: false, sq: true, s3: false, s4: false, s5: false, s6: false, s7: false });
  const [requests, setRequests] = useS([]);

  // Admission queue of the live mode: the controller's view, the polling mode and the user
  // the queue context belongs to.
  const [pollMode, setPollMode] = useS(initialPollMode);
  const [admission, setAdmission] = useS(null);
  const [purchaseError, setPurchaseError] = useS(null);
  const [queueUser, setQueueUser] = useS({ apiBase: "", mode: "", userId: "" });
  const [queueNonce, setQueueNonce] = useS(0);
  const admissionRef = useR(null);
  const pollModeRef = useR(pollMode);
  const lastPollRef = useR(null);
  const sessionGenRef = useR(0);
  pollModeRef.current = pollMode;
  // The queue context follows the last user a live session was issued for on this API base.
  // A session that expired or was cleared keeps it; another API base or mode has none until
  // its own session exists, and that holds from the very render in which the base changed.
  const queueUserId = queueUser.apiBase === apiBase && queueUser.mode === mode ? queueUser.userId : "";

  // [FIX] Per-button in-flight indicator for Step 6 (Duplicate / Retry).
  // A and B each track their own busy state so one button's pending request
  // does NOT lock the other one out via the shared stepStatus.s6 = "running" flag.
  const [dupBusy, setDupBusy] = useS({ A: false, B: false });

  const clearLiveDemoSession = useC(() => {
    // A session that is still being issued belongs to what was cleared; see below.
    sessionGenRef.current += 1;
    liveSessionRef.current = null;
    liveSessionInFlightRef.current = null;
    setLiveSession(null);
    setLiveSessionStatus("idle");
    setLiveSessionError("");
  }, []);

  const ensureLiveDemoSession = useC(async () => {
    if (mode !== "live") {
      throw new Error("Live demo sessions are available only in Live mode");
    }

    const current = liveSessionRef.current;
    if (current && Date.parse(current.expiresAt) > Date.now() + 30_000) {
      return current;
    }

    if (liveSessionInFlightRef.current) {
      return liveSessionInFlightRef.current;
    }

    setLiveSessionStatus("loading");
    setLiveSessionError("");

    // A session answered after the API base, the mode or the session itself was reset is the
    // answer of an earlier context and must not become the current one.
    const gen = sessionGenRef.current;
    const request = (async () => {
      try {
        const response = await callLive(apiBase, "POST", "/demo/session");
        if (sessionGenRef.current !== gen) throw new Error("Live demo session was reset while it was being issued");
        const session = response.data;
        const isValidSession = response.ok &&
          session &&
          typeof session.token === "string" &&
          typeof session.userId === "string" &&
          typeof session.email === "string" &&
          typeof session.expiresAt === "string" &&
          Number.isFinite(Date.parse(session.expiresAt));

        if (!isValidSession) {
          throw new Error("Unable to start live demo session");
        }

        const nextSession = {
          token: session.token,
          userId: session.userId,
          email: session.email,
          expiresAt: session.expiresAt,
        };
        liveSessionRef.current = nextSession;
        setLiveSession(nextSession);
        setLiveSessionStatus("active");
        return nextSession;
      } catch (error) {
        if (sessionGenRef.current === gen) {
          liveSessionRef.current = null;
          setLiveSession(null);
          setLiveSessionStatus("error");
          setLiveSessionError("Unable to start live demo session");
        }
        throw error;
      } finally {
        if (liveSessionInFlightRef.current === request) liveSessionInFlightRef.current = null;
      }
    })();

    liveSessionInFlightRef.current = request;
    return request;
  }, [apiBase, mode]);

  const isInvalidLiveToken = (response) =>
    response.status === 401 && response.data?.error?.code === "INVALID_TOKEN";

  // Persist only non-sensitive UI preferences. The live JWT must never leave memory.
  useE(() => localStorage.setItem("pp_api_base", apiBase), [apiBase]);
  useE(() => localStorage.setItem("pp_mode", mode), [mode]);
  useE(() => localStorage.setItem("pp_user_id", userId), [userId]);
  useE(() => { if (selectedEventId) localStorage.setItem("pp_event_id", selectedEventId); }, [selectedEventId]);
  useE(() => { if (selectedTierId) localStorage.setItem("pp_tier_id", selectedTierId); }, [selectedTierId]);
  useE(() => {
    clearLiveDemoSession();
  }, [apiBase, mode, clearLiveDemoSession]);

  // mark step helpers
  const setStep = (k, s) => setStepStatus(prev => ({ ...prev, [k]: s }));
  const setTiming = (k, t) => setStepTiming(prev => ({ ...prev, [k]: t }));

  const logReq = (entry) => setRequests(prev => [...prev, entry]);

  // ------- admission queue (live mode) -------
  useE(() => localStorage.setItem("pp_poll_mode", pollMode), [pollMode]);
  // Switching the mode changes only how the next poll is scheduled: the entry, the join key
  // and a request in flight stay as they are.
  useE(() => { admissionRef.current?.setMode(pollMode); }, [pollMode]);

  useE(() => {
    if (liveSession?.userId) setQueueUser({ apiBase, mode, userId: liveSession.userId });
  }, [liveSession]);

  // Step 4 sends the tier and quantity the form shows, so the form follows the reservation the
  // page holds: one just made, one repeated after a reload, or one read back.
  const adoptReservation = (data) => {
    setReservation(data);
    if (Number.isInteger(data?.quantity)) setQuantity(data.quantity);
    if (data?.tierId) setSelectedTierId(data.tierId);
  };

  // One controller per context (API base, user, event). It is disposed before the next one
  // starts, so a response of an earlier context has nowhere to land, and the new one always
  // begins by reading the state from the server.
  useE(() => {
    if (mode !== "live" || !isUuid(selectedEventId)) return undefined;
    if (!queueUserId) {
      // Recover without a click, so that a waiting user who reloads keeps polling. The delay
      // keeps a half-typed API base from being probed on every keystroke.
      const timer = setTimeout(() => { ensureLiveDemoSession().catch(() => {}); }, 400);
      return () => clearTimeout(timer);
    }

    const none = { status: 0, data: null, retryAfterMs: null };
    // Sends with the session of this context's user. A rejected token is replaced once, and
    // only by a session of the same user.
    const authorized = async (send) => {
      let session = await ensureLiveDemoSession();
      if (session.userId !== queueUserId) return none;
      let response = await send({ Authorization: `Bearer ${session.token}` });
      if (response.status === 401) {
        liveSessionRef.current = null;
        session = await ensureLiveDemoSession();
        if (session.userId !== queueUserId) return none;
        response = await send({ Authorization: `Bearer ${session.token}` });
      }
      return response;
    };

    const controller = window.PeakPassAdmission.createController({
      userId: queueUserId,
      eventId: selectedEventId,
      mode: pollModeRef.current,
      uuid: window.uuid,
      visibility: pageVisibility,
      pending: pendingPurchases,
      seen: seenAdmissions,
      async transport({ method, path, body, signal }) {
        try {
          const response = await authorized((headers) =>
            callLive(apiBase, method, path, body, headers, false, signal));
          const entry = { method, url: path, status: response.status, elapsed: response.elapsed || 0,
                          request: body || null, response: response.data };
          if (method === "GET") lastPollRef.current = entry;
          else logReq(entry);
          return response;
        } catch {
          return none;
        }
      },
      async sendPurchase(body, signal) {
        try {
          const response = await authorized((headers) =>
            callLive(apiBase, "POST", "/reservations", body, headers, false, signal));
          logReq({ method: "POST", url: "/reservations", status: response.status, elapsed: response.elapsed || 0,
                   request: body, response: response.data });
          if (response.elapsed) setStepTiming(prev => ({ ...prev, s3: response.elapsed }));
          return response;
        } catch {
          return none;
        }
      },
      onChange: setAdmission,
      onTrace(event) {
        admissionTrace.push(event);
        // The request log lists a status poll only when it changed what the card shows. A poll
        // without an answer has nothing on record but the answer of an earlier poll, so its
        // line is written from the event.
        if (event.type !== "poll" || !event.changed) return;
        if (event.status === 0) {
          logReq({ method: "GET", url: `/events/${selectedEventId}/admissions/me`, status: 0,
                   elapsed: Math.round(event.tRecv - event.tSend), request: null,
                   response: { error: event.timedOut ? "No answer within the timeout" : "No answer" } });
        } else if (lastPollRef.current) logReq(lastPollRef.current);
      },
      onPurchaseResult({ status, data }) {
        if (status >= 200 && status < 300) {
          adoptReservation(data);
          setPurchaseError(null);
          setStepStatus(prev => ({ ...prev, s3: "done" }));
        } else {
          setPurchaseError({ status, code: data?.error?.code || null, message: data?.error?.message || "" });
          setStepStatus(prev => ({ ...prev, s3: "error" }));
        }
      },
    });
    admissionRef.current = controller;
    controller.start();
    return () => {
      controller.dispose();
      admissionRef.current = null;
      setAdmission(null);
      // A purchase this controller still had open ends with it, so step 3 is not running any
      // more. The request stays restorable for the same user and event.
      setStepStatus(prev => prev.s3 === "running" ? { ...prev, s3: "idle" } : prev);
    };
  }, [mode, apiBase, selectedEventId, queueUserId, queueNonce, ensureLiveDemoSession]);

  const api = {
    async graphql(query, variables) {
      if (mode === "mock") return mockServer.graphql(query, variables);
      return callLive(apiBase, "POST", "/graphql", { query, variables });
    },
    async reservations(body, token) {
      if (mode === "mock") return mockServer.reservations(body);
      return callLive(apiBase, "POST", "/reservations", body,
        token ? { "Authorization": `Bearer ${token}` } : {});
    },
    async checkouts(body, idemKey, token) {
      if (mode === "mock") return mockServer.checkouts(body, idemKey);
      return callLive(apiBase, "POST", "/checkouts", body, {
        "Idempotency-Key": idemKey,
        ...(token ? { "Authorization": `Bearer ${token}` } : {})
      });
    },
    async settlement(body, idemKey) {
      if (mode === "mock") return mockServer.settlement(body, idemKey);
      return callLive(apiBase, "POST", "/webhooks/payments/settlement", body, { "Idempotency-Key": idemKey });
    },
    async demoSettlement(body, idemKey, token) {
      return callLive(apiBase, "POST", "/demo/settlement", body, {
        "Idempotency-Key": idemKey,
        "Authorization": `Bearer ${token}`,
      });
    },
    async health() {
      if (mode === "mock") return mockServer.health();
      return callLive(apiBase, "GET", "/health");
    },
    async ready() {
      if (mode === "mock") return mockServer.ready();
      return callLive(apiBase, "GET", "/ready");
    }
  };

  // ------- actions -------
  const selectedEvent = events?.find(e => e.id === selectedEventId);
  const selectedTier = selectedEvent?.pricing?.find(p => p.tierId === selectedTierId);

  const actions = {
    toggleStep: (k) => setExpandedSteps(prev => ({ ...prev, [k]: !prev[k] })),
    gotoStep: (n) => { setActiveStep(n); setExpandedSteps(prev => ({ ...prev, ["s"+n]: true })); },
    markStepDone: (k) => setStep(k, "done"),

    selectEvent: (id) => {
      setSelectedEventId(id);
      const ev = events?.find(e => e.id === id);
      if (ev && !selectedTierId) setSelectedTierId(ev.pricing[0].tierId);
      actions.markStepDone("s1");
    },
    selectTier: (id) => setSelectedTierId(id),
    setQuantity, setUserId, setLookupCode,

    regenCheckoutKey: () => setCheckoutIdemKey(uuid()),
    regenSettlementKey: () => setSettlementIdemKey(uuid()),

    // Queue actions are explicit: nothing joins, cancels or buys again by itself.
    joinQueue: () => { admissionRef.current?.join(); },
    cancelQueue: () => { admissionRef.current?.cancel(); },
    retryPurchase: () => {
      if (admissionRef.current?.retryPurchase()) { setPurchaseError(null); setStep("s3", "running"); }
    },
    setPollMode,
    // Starts the queue context again: a new session if needed, then a GET.
    recheckQueue: () => {
      if (queueUserId) setQueueNonce(n => n + 1);
      else ensureLiveDemoSession().catch(() => {});
    },
    // After a reload the page no longer holds the reservation an admission was used for.
    loadReservation: async () => {
      const id = admission?.admission?.outcome?.resourceId;
      const context = admissionRef.current;
      if (!id || !context) return;
      try {
        const session = await ensureLiveDemoSession();
        const res = await callLive(apiBase, "GET", `/reservations/${id}`, null,
          { "Authorization": `Bearer ${session.token}` });
        // An answer that arrives after the event, user or API base changed belongs to the
        // context that asked for it and is dropped, as the controller drops its own.
        if (admissionRef.current !== context) return;
        logReq({ method: "GET", url: `/reservations/${id}`, status: res.status, elapsed: res.elapsed || 0,
                 request: null, response: res.data });
        if (!res.ok) return;
        adoptReservation(res.data);
        setPurchaseError(null);
        setStep("s3", "done");
      } catch {}
    },

    reset: () => {
      setReservation(null); setOrder(null); setSettlement(null);
      setDuplicateReplay(null); setDuplicateSemantic(null); setTicketByCode(null);
      setStepStatus({ s1:"idle",s2:"idle",s3:"idle",s4:"idle",s5:"idle",s6:"idle",s7:"idle" });
      setStepTiming({});
      setCheckoutIdemKey(""); setSettlementIdemKey(""); setProviderTxnId("");
      setRequests([]); setLookupCode("");
      setActiveStep(1);
      setExpandedSteps({ s1:true,s2:false,sq:true,s3:false,s4:false,s5:false,s6:false,s7:false });
      setDupBusy({ A: false, B: false }); // [FIX] reset per-button busy flags
      setPurchaseError(null);
      // Reset is local: an entry in the queue stays on the server and is read again.
      clearLiveDemoSession();
    },

    step1: async () => {
      setStep("s1", "running"); setActiveStep(1);
      const query = `query Events($limit: Int, $offset: Int) {
  events(limit: $limit, offset: $offset) { id name description startsAt totalSeats availableSeats pricing { tierId name price seats } }
}`;
      const res = await api.graphql(query, { limit: 10, offset: 0 });
      logReq({ method: "GQL", url: "/graphql · events", status: res.status, elapsed: res.elapsed || 200,
               request: { query, variables: { limit: 10, offset: 0 } }, response: res.data });
      if (res.ok) {
        const list = res.data?.data?.events || window.MOCK_EVENTS;
        setEvents(list);
        setTiming("s1", res.elapsed || 200);
        setStep("s1", "done");
        if (!selectedEventId) setSelectedEventId(list[0].id);
        if (!selectedTierId) setSelectedTierId(list[0].pricing[0].tierId);
      } else {
        setStep("s1", "error");
      }
    },

    step3: async () => {
      if (!selectedEvent || !selectedTier) return;
      const queue = admissionRef.current;
      const queued = queue?.view();
      if (mode === "live" && queued?.phase === "admitted") {
        // A protected event: the reservation carries the admission (admission-v1 §3). The
        // controller sends it as one frozen request and, when the outcome is unknown, repeats
        // exactly that request. The result arrives through onPurchaseResult.
        const body = {
          eventId: selectedEvent.id,
          userId: queueUserId,
          quantity,
          tierId: selectedTier.tierId,
          admissionId: queued.admission.admissionId,
          admissionEpoch: queued.admission.epoch,
        };
        if (!queue.purchase(body)) return;
        setPurchaseError(null);
        setStep("s3", "running");
        actions.gotoStep(3);
        return;
      }
      setStep("s3", "running"); setActiveStep(3);
      actions.gotoStep(3);
      try {
        let session = mode === "live" ? await ensureLiveDemoSession() : null;
        let body = {
          eventId: selectedEvent.id,
          userId: session?.userId || userId,
          quantity,
          tierId: selectedTier.tierId
        };
        let res = await api.reservations(body, session?.token);

        if (mode === "live" && isInvalidLiveToken(res)) {
          logReq({ method: "POST", url: "/reservations", status: res.status, elapsed: res.elapsed || 200,
                   request: body, response: res.data });
          clearLiveDemoSession();
          session = await ensureLiveDemoSession();
          body = { ...body, userId: session.userId };
          res = await api.reservations(body, session.token);
        }

        logReq({ method: "POST", url: "/reservations", status: res.status, elapsed: res.elapsed || 200,
                 request: body, response: res.data });
        if (res.ok) {
          setReservation(res.data);
          setTiming("s3", res.elapsed || 200);
          setStep("s3", "done");
        } else setStep("s3", "error");
      } catch {
        setStep("s3", "error");
      }
    },

    step4: async () => {
      if (!reservation) return;
      setStep("s4", "running"); setActiveStep(4);
      actions.gotoStep(4);
      const key = checkoutIdemKey || uuid();
      if (!checkoutIdemKey) setCheckoutIdemKey(key);
      try {
        let session = mode === "live" ? await ensureLiveDemoSession() : null;
        let body = {
          eventId: selectedEvent.id,
          userId: session?.userId || userId,
          quantity,
          tierId: selectedTier.tierId,
          reservationId: reservation.id
        };
        let res = await api.checkouts(body, key, session?.token);

        if (mode === "live" && isInvalidLiveToken(res)) {
          logReq({ method: "POST", url: "/checkouts", idemKey: key, status: res.status, elapsed: res.elapsed || 200,
                   request: body, response: res.data });
          clearLiveDemoSession();
          session = await ensureLiveDemoSession();
          body = { ...body, userId: session.userId };
          res = await api.checkouts(body, key, session.token);
        }

        logReq({ method: "POST", url: "/checkouts", idemKey: key, status: res.status, elapsed: res.elapsed || 200,
                 request: body, response: res.data });
        if (res.ok) {
          setOrder(res.data);
          setTiming("s4", res.elapsed || 200);
          setStep("s4", "done");
        } else setStep("s4", "error");
      } catch {
        setStep("s4", "error");
      }
    },

    step5: async () => {
      if (!order) return;
      setStep("s5", "running"); setActiveStep(5);
      actions.gotoStep(5);
      const key = settlementIdemKey || uuid();
      if (!settlementIdemKey) setSettlementIdemKey(key);

      if (mode === "live") {
        try {
          let session = await ensureLiveDemoSession();
          const body = { orderId: order.order.id };
          let res = await api.demoSettlement(body, key, session.token);

          if (isInvalidLiveToken(res)) {
            logReq({ method: "POST", url: "/demo/settlement", idemKey: key, status: res.status, elapsed: res.elapsed || 200,
                     request: body, response: res.data });
            clearLiveDemoSession();
            session = await ensureLiveDemoSession();
            res = await api.demoSettlement(body, key, session.token);
          }

          logReq({ method: "POST", url: "/demo/settlement", idemKey: key, status: res.status, elapsed: res.elapsed || 200,
                   request: body, response: res.data });
          if (res.ok) {
            setSettlement(res.data);
            setTiming("s5", res.elapsed || 200);
            setStep("s5", "done");
            if (res.data?.tickets?.[0]?.ticketNumber) setLookupCode(res.data.tickets[0].ticketNumber);
          } else setStep("s5", "error");
        } catch {
          setStep("s5", "error");
        }
        return;
      }

      const txn = providerTxnId || `txn-demo-${Date.now()}`;
      if (!providerTxnId) setProviderTxnId(txn);
      const body = { orderId: order.order.id, providerTransactionId: txn, status: "settled" };
      const res = await api.settlement(body, key);
      logReq({ method: "POST", url: "/webhooks/payments/settlement", idemKey: key, status: res.status, elapsed: res.elapsed || 200,
               request: body, response: res.data });
      if (res.ok) {
        setSettlement(res.data);
        setTiming("s5", res.elapsed || 200);
        setStep("s5", "done");
        if (res.data?.tickets?.[0]?.ticketNumber) setLookupCode(res.data.tickets[0].ticketNumber);
      } else setStep("s5", "error");
    },

    // [FIX] runDupReplay — A 케이스 (Cache replay)
    // - per-button busy flag(dupBusy.A)로 A 자신만 잠금. B는 영향 없음.
    // - 성공 시 자체적으로 setStep("s6", "done") 호출 — 더 이상 다른 케이스의 상태에 의존하지 않음.
    // - 이미 done이면 "running"으로 되돌리지 않아 progress flicker 방지 (functional update).
    runDupReplay: async () => {
      if (!order || !settlementIdemKey) return;
      if (mode === "live") {
        if (dupBusy.A) return;
        setDupBusy(prev => ({ ...prev, A: true }));
        setStepStatus(prev => prev.s6 === "done" ? prev : { ...prev, s6: "running" });
        setActiveStep(6);
        try {
          let session = await ensureLiveDemoSession();
          const body = { orderId: order.order.id };
          let res = await api.demoSettlement(body, settlementIdemKey, session.token);

          if (isInvalidLiveToken(res)) {
            logReq({ method: "POST", url: "/demo/settlement (replay)", idemKey: settlementIdemKey, status: res.status, elapsed: res.elapsed || 200,
                     request: body, response: res.data });
            clearLiveDemoSession();
            session = await ensureLiveDemoSession();
            res = await api.demoSettlement(body, settlementIdemKey, session.token);
          }

          logReq({ method: "POST", url: "/demo/settlement (replay)", idemKey: settlementIdemKey, status: res.status, elapsed: res.elapsed || 200,
                   request: body, response: res.data });
          if (res.ok) {
            setDuplicateReplay(res.data);
            setStep("s6", "done");
          } else {
            setStepStatus(prev => prev.s6 === "running" ? { ...prev, s6: "idle" } : prev);
          }
        } catch {
          setStepStatus(prev => prev.s6 === "running" ? { ...prev, s6: "idle" } : prev);
        } finally {
          setDupBusy(prev => ({ ...prev, A: false }));
        }
        return;
      }
      if (dupBusy.A) return; // 같은 버튼 더블클릭 방지
      setDupBusy(prev => ({ ...prev, A: true }));
      setStepStatus(prev => prev.s6 === "done" ? prev : { ...prev, s6: "running" });
      setActiveStep(6);
      try {
        const body = { orderId: order.order.id, providerTransactionId: providerTxnId, status: "settled" };
        const res = await api.settlement(body, settlementIdemKey);
        logReq({ method: "POST", url: "/webhooks/payments/settlement (replay)", idemKey: settlementIdemKey, status: res.status, elapsed: res.elapsed || 200,
                 request: body, response: res.data });
        if (res.ok) {
          setDuplicateReplay(res.data);
          setStep("s6", "done");
        } else {
          // 한 케이스 실패해도 다른 케이스는 시도 가능해야 하므로
          // s6 자체를 error로 떨구지 않고 idle 상태로 복귀시킴 (이미 done이면 그대로 유지).
          setStepStatus(prev => prev.s6 === "running" ? { ...prev, s6: "idle" } : prev);
        }
      } finally {
        setDupBusy(prev => ({ ...prev, A: false }));
      }
    },

    // [FIX] runDupSemantic — B 케이스 (Semantic duplicate)
    // - 위와 동일 패턴. dupBusy.B만 사용.
    runDupSemantic: async () => {
      if (!order) return;
      if (mode === "live") {
        if (dupBusy.B) return;
        setDupBusy(prev => ({ ...prev, B: true }));
        setStepStatus(prev => prev.s6 === "done" ? prev : { ...prev, s6: "running" });
        setActiveStep(6);
        try {
          const newKey = uuid();
          let session = await ensureLiveDemoSession();
          const body = { orderId: order.order.id };
          let res = await api.demoSettlement(body, newKey, session.token);

          if (isInvalidLiveToken(res)) {
            logReq({ method: "POST", url: "/demo/settlement (new-key, same-transaction)", idemKey: newKey, status: res.status, elapsed: res.elapsed || 200,
                     request: body, response: res.data });
            clearLiveDemoSession();
            session = await ensureLiveDemoSession();
            res = await api.demoSettlement(body, newKey, session.token);
          }

          logReq({ method: "POST", url: "/demo/settlement (new-key, same-transaction)", idemKey: newKey, status: res.status, elapsed: res.elapsed || 200,
                   request: body, response: res.data });
          if (res.ok) {
            setDuplicateSemantic(res.data);
            setStep("s6", "done");
          } else {
            setStepStatus(prev => prev.s6 === "running" ? { ...prev, s6: "idle" } : prev);
          }
        } catch {
          setStepStatus(prev => prev.s6 === "running" ? { ...prev, s6: "idle" } : prev);
        } finally {
          setDupBusy(prev => ({ ...prev, B: false }));
        }
        return;
      }
      if (dupBusy.B) return; // 같은 버튼 더블클릭 방지
      setDupBusy(prev => ({ ...prev, B: true }));
      setStepStatus(prev => prev.s6 === "done" ? prev : { ...prev, s6: "running" });
      setActiveStep(6);
      try {
        const newKey = uuid();
        const body = { orderId: order.order.id, providerTransactionId: providerTxnId, status: "settled" };
        const res = await api.settlement(body, newKey);
        logReq({ method: "POST", url: "/webhooks/payments/settlement (new-key, same-txn)", idemKey: newKey, status: res.status, elapsed: res.elapsed || 200,
                 request: body, response: res.data });
        if (res.ok) {
          setDuplicateSemantic(res.data);
          setStep("s6", "done");
        } else {
          setStepStatus(prev => prev.s6 === "running" ? { ...prev, s6: "idle" } : prev);
        }
      } finally {
        setDupBusy(prev => ({ ...prev, B: false }));
      }
    },

    step7: async () => {
      if (!lookupCode) return;
      setStep("s7", "running"); setActiveStep(7);
      actions.gotoStep(7);
      const query = `query TicketByCode($code: String!) { ticketByCode(code: $code) { valid status ticketNumber eventName startsAt endsAt } }`;
      const res = await api.graphql(query, { code: lookupCode });
      logReq({ method: "GQL", url: "/graphql · ticketByCode", status: res.status, elapsed: res.elapsed || 200,
               request: { query, variables: { code: lookupCode } }, response: res.data });
      if (res.ok) {
        setTicketByCode(res.data?.data?.ticketByCode || null);
        setTiming("s7", res.elapsed || 200);
        setStep("s7", "done");
      } else setStep("s7", "error");
    },

    runAll: async () => {
      if (mode === "live") return;
      actions.reset();
      await new Promise(r => setTimeout(r, 100));
      await actions.step1();
      await new Promise(r => setTimeout(r, 350));
      // ensure selection
      const ev = (events || window.MOCK_EVENTS)[0];
      setSelectedEventId(ev.id); setSelectedTierId(ev.pricing[0].tierId);
      setStep("s2", "done"); setActiveStep(3); setExpandedSteps(p => ({ ...p, s3: true }));
      await new Promise(r => setTimeout(r, 250));
      // step3 uses latest selection — wait a tick
      setReservation(null);
      const body3 = { eventId: ev.id, userId, quantity, tierId: ev.pricing[0].tierId };
      setStep("s3", "running");
      const r3 = await api.reservations(body3);
      logReq({ method:"POST", url:"/reservations", status:r3.status, elapsed:r3.elapsed||200, request: body3, response: r3.data });
      if (!r3.ok) { setStep("s3","error"); return; }
      setReservation(r3.data); setTiming("s3", r3.elapsed||200); setStep("s3","done");
      setActiveStep(4); setExpandedSteps(p => ({ ...p, s4: true }));
      await new Promise(r => setTimeout(r, 350));

      const k4 = uuid(); setCheckoutIdemKey(k4);
      const body4 = { ...body3, reservationId: r3.data.id };
      setStep("s4","running");
      const r4 = await api.checkouts(body4, k4);
      logReq({ method:"POST", url:"/checkouts", idemKey:k4, status:r4.status, elapsed:r4.elapsed||200, request: body4, response: r4.data });
      if (!r4.ok) { setStep("s4","error"); return; }
      setOrder(r4.data); setTiming("s4", r4.elapsed||200); setStep("s4","done");
      setActiveStep(5); setExpandedSteps(p => ({ ...p, s5: true }));
      await new Promise(r => setTimeout(r, 500));

      const k5 = uuid(); setSettlementIdemKey(k5);
      const txn = `txn-demo-${Date.now()}`; setProviderTxnId(txn);
      const body5 = { orderId: r4.data.order.id, providerTransactionId: txn, status:"settled" };
      setStep("s5","running");
      const r5 = await api.settlement(body5, k5);
      logReq({ method:"POST", url:"/webhooks/payments/settlement", idemKey:k5, status:r5.status, elapsed:r5.elapsed||200, request: body5, response: r5.data });
      if (!r5.ok) { setStep("s5","error"); return; }
      setSettlement(r5.data); setTiming("s5", r5.elapsed||200); setStep("s5","done");
      const code = r5.data?.tickets?.[0]?.ticketNumber;
      if (code) setLookupCode(code);
      setActiveStep(6); setExpandedSteps(p => ({ ...p, s6: true }));
      await new Promise(r => setTimeout(r, 400));

      // dup A
      const rA = await api.settlement(body5, k5);
      logReq({ method:"POST", url:"/webhooks/payments/settlement (replay)", idemKey:k5, status:rA.status, elapsed:rA.elapsed||200, request: body5, response: rA.data });
      setDuplicateReplay(rA.data);
      await new Promise(r => setTimeout(r, 300));

      // dup B
      const kB = uuid();
      const rB = await api.settlement(body5, kB);
      logReq({ method:"POST", url:"/webhooks/payments/settlement (new-key, same-txn)", idemKey:kB, status:rB.status, elapsed:rB.elapsed||200, request: body5, response: rB.data });
      setDuplicateSemantic(rB.data);
      setStep("s6","done");
      setActiveStep(7); setExpandedSteps(p => ({ ...p, s7: true }));
      await new Promise(r => setTimeout(r, 400));

      // step 7
      if (code) {
        const query = `query TicketByCode($code: String!) { ticketByCode(code: $code) { valid status ticketNumber eventName startsAt endsAt } }`;
        setStep("s7","running");
        const r7 = await api.graphql(query, { code });
        logReq({ method:"GQL", url:"/graphql · ticketByCode", status:r7.status, elapsed:r7.elapsed||200, request: { query, variables: { code } }, response: r7.data });
        if (r7.ok) { setTicketByCode(r7.data?.data?.ticketByCode); setTiming("s7", r7.elapsed||200); setStep("s7","done"); }
      }
    }
  };

  // After a reload the page still knows which event was selected but not its tiers, and step 3
  // needs them. An entry recovered as admitted has 30 s, so the events are read without a click.
  useE(() => {
    if (mode === "live" && isUuid(selectedEventId) && !events) actions.step1();
  }, [mode, selectedEventId]);

  // connection panel handlers
  const onCheckHealth = async () => {
    const res = await api.health();
    logReq({ method: "GET", url: "/health", status: res.status, elapsed: res.elapsed || 100, request: null, response: res.data });
    setHealth(res.ok ? { ok: true, ...res.data } : { err: true, ...res.data });
  };
  const onCheckReady = async () => {
    const res = await api.ready();
    logReq({ method: "GET", url: "/ready", status: res.status, elapsed: res.elapsed || 100, request: null, response: res.data });
    setReady({ ...res.data, ok: res.ok, httpStatus: res.status });
  };
  const onLoadEvents = () => actions.step1();

  const toggleMock = () => setMode(m => m === "mock" ? "live" : "mock");

  const state = {
    mode, events, selectedEventId, selectedTierId,
    userId: mode === "live" ? liveSession?.userId || "" : userId,
    liveSessionUserId: liveSession?.userId || "",
    liveSessionExpiresAt: liveSession?.expiresAt || "",
    liveSessionStatus, liveSessionError,
    quantity,
    reservation, order, settlement, duplicateReplay, duplicateSemantic, ticketByCode, lookupCode,
    stepStatus, stepTiming, activeStep, expandedSteps, requests,
    checkoutIdemKey, settlementIdemKey, providerTxnId,
    dupBusy, // [FIX] expose per-button busy state to DemoFlow
    // admission queue (live mode): the controller's view and what the card needs around it
    admission, pollMode, purchaseError, queueUserId,
    queueEnabled: mode === "live" && isUuid(selectedEventId)
  };

  return (
    <div className="app">
      <TopBar mode={mode} onToggleMock={toggleMock} apiBase={apiBase}/>
      <Hero/>
      <ArchitectureStrip/>
      <ConnectionPanel
        apiBase={apiBase} setApiBase={setApiBase}
        mode={mode} setMode={setMode}
        health={health} ready={ready}
        onCheckHealth={onCheckHealth} onCheckReady={onCheckReady} onLoadEvents={onLoadEvents}
        eventsLoaded={!!events}
      />
      <DemoFlow state={state} actions={actions}/>
      <RequestLog requests={requests} onClear={() => setRequests([])}/>
      <div className="footer">
        PeakPass · Ticketing Consistency Demo · React + Fastify + PostgreSQL + Redis · © 2026 · github.com/dosacha/PeakPass
      </div>
    </div>
  );
};

ReactDOM.createRoot(document.getElementById("root")).render(<App/>);
