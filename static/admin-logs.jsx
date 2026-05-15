/* eslint-disable no-undef */
/* ============================================================
   Logs Screen — fullscreen live monitoring view
   Sibling of the Agent screen. Constantly queries Monitoring
   MCP for recent logs across all services.
   ============================================================ */

const LOG_SERVICES = [
  { id: "kassa",       label: "Kassa",       svc: "kassa",      docs: 396  },
  { id: "facturatie",  label: "Facturatie",  svc: "facturatie", docs: 1645 },
  { id: "crm",         label: "CRM",         svc: "crm",        docs: 812  },
  { id: "frontend",    label: "Frontend",    svc: "frontend",   docs: 4218 },
  { id: "planning",    label: "Planning",    svc: "frontend",   docs: 233  },
  { id: "identity",    label: "Identity",    svc: "llama",      docs: 109  },
  { id: "mailing",     label: "Mailing",     svc: "monitoring", docs: 47   },
  { id: "monitoring",  label: "Monitoring",  svc: "monitoring", docs: 2890 },
];

// Per-service stat breakdown: { level, action, count }
const STATS = {
  kassa: [
    { level: "error",   action: "system_error",    count: 192 },
    { level: "error",   action: "xml_validation",  count: 53 },
    { level: "info",    action: "payment",         count: 62 },
    { level: "info",    action: "session",         count: 52 },
    { level: "info",    action: "xml_validation",  count: 23 },
    { level: "info",    action: "registration",    count: 14 },
  ],
  facturatie: [
    { level: "error",   action: "system_error",    count: 514 },
    { level: "error",   action: "xml_validation",  count: 96 },
    { level: "info",    action: "xml_validation",  count: 518 },
    { level: "info",    action: "invoice",         count: 366 },
    { level: "info",    action: "email",           count: 88 },
    { level: "info",    action: "payment",         count: 45 },
    { level: "info",    action: "registration",    count: 14 },
  ],
  crm: [
    { level: "info",    action: "registration",    count: 412 },
    { level: "info",    action: "lookup",          count: 188 },
    { level: "info",    action: "profile_update",  count: 78 },
    { level: "warning", action: "rate_limit",      count: 19 },
    { level: "error",   action: "xml_validation",  count: 14 },
  ],
  frontend: [
    { level: "info",    action: "page_view",       count: 2614 },
    { level: "info",    action: "session_start",   count: 824  },
    { level: "info",    action: "form_submit",     count: 412  },
    { level: "warning", action: "slow_render",     count: 38   },
    { level: "error",   action: "client_error",    count: 12   },
  ],
  planning: [
    { level: "info",    action: "session_view",    count: 178 },
    { level: "info",    action: "enrol",           count: 41  },
    { level: "warning", action: "capacity",        count: 8   },
    { level: "info",    action: "schedule_change", count: 6   },
  ],
  identity: [
    { level: "info",    action: "auth.login",      count: 64 },
    { level: "info",    action: "token.refresh",   count: 31 },
    { level: "warning", action: "rate_limit",      count: 9  },
    { level: "error",   action: "auth.fail",       count: 5  },
  ],
  mailing: [
    { level: "error",   action: "smtp_timeout",    count: 31 },
    { level: "warning", action: "queue_backed_up", count: 12 },
    { level: "info",    action: "sent",            count: 4  },
  ],
  monitoring: [
    { level: "info",    action: "heartbeat",       count: 2780 },
    { level: "info",    action: "index",           count: 88   },
    { level: "warning", action: "service_lag",     count: 18   },
    { level: "error",   action: "service_down",    count: 4    },
  ],
};

// Seed messages per service (action + level + template)
const LOG_TEMPLATES = {
  kassa: [
    { level: "info",  action: "payment",        msg: "Order %ID processed for %WHO" },
    { level: "info",  action: "session",        msg: "Kassa Integration Service started and monitoring active." },
    { level: "info",  action: "xml_validation", msg: "Validated order_created from queue.kassa.in · ok" },
    { level: "info",  action: "registration",   msg: "Registered new POS terminal pos-%ID" },
    { level: "error", action: "xml_validation", msg: "Schema mismatch on order_created — missing field 'currency'" },
    { level: "error", action: "system_error",   msg: "RabbitMQ disconnect — retrying in 3s" },
  ],
  facturatie: [
    { level: "info",  action: "invoice",        msg: "Invoice %ID cancelled" },
    { level: "info",  action: "invoice",        msg: "Published invoice_cancelled to crm.incoming. CorrelationID: %CORR" },
    { level: "info",  action: "xml_validation", msg: "Received invoice_cancelled from crm. Validation: Success." },
    { level: "info",  action: "email",          msg: "Sent reminder for INV-2026-0%ID to acme@example.be" },
    { level: "info",  action: "payment",        msg: "Payment received for INV-2026-0%ID — €%AMT" },
    { level: "error", action: "system_error",   msg: "DB connection pool exhausted — opening replica" },
  ],
  crm: [
    { level: "info",  action: "registration",   msg: "New member registered · %WHO · uuid=%CORR" },
    { level: "info",  action: "lookup",         msg: "resolve_user_by_email · %WHO@example.be" },
    { level: "info",  action: "profile_update", msg: "Member %WHO updated address" },
    { level: "warning", action: "rate_limit",   msg: "Rate limit hit for endpoint /members · 60 req/min" },
  ],
  frontend: [
    { level: "info",  action: "page_view",      msg: "GET /sessions · 200 · %ID ms" },
    { level: "info",  action: "form_submit",    msg: "POST /api/enrol/sess-%ID · 200" },
    { level: "warning", action: "slow_render",  msg: "Long task on /admin/dashboard · %ID ms blocked main thread" },
  ],
  planning: [
    { level: "info",  action: "session_view",   msg: "Viewed session sess-%ID by user uuid=%CORR" },
    { level: "info",  action: "enrol",          msg: "Enrolled %WHO in sess-%ID" },
    { level: "warning", action: "capacity",     msg: "Session sess-%ID near capacity (28/30)" },
  ],
  identity: [
    { level: "info",  action: "auth.login",     msg: "auth.login · %WHO@example.be · ok" },
    { level: "info",  action: "token.refresh",  msg: "Refreshed JWT for uuid=%CORR" },
    { level: "error", action: "auth.fail",      msg: "auth.fail · invalid_password · ip=10.0.%ID.%ID" },
  ],
  mailing: [
    { level: "error",   action: "smtp_timeout",    msg: "SMTP connection timed out · smtp.shift.be:587 — retry %ID/3" },
    { level: "warning", action: "queue_backed_up", msg: "Mailing queue lag: %ID messages waiting · oldest 14m" },
  ],
  monitoring: [
    { level: "info",  action: "heartbeat",      msg: "heartbeat · %WHO · uptime 23h" },
    { level: "warning", action: "service_lag",  msg: "Service %WHO heartbeat lag · 14s · last seen 00:01:23" },
    { level: "error", action: "service_down",   msg: "Service mailing marked offline — 612s without heartbeat" },
  ],
};

function rand(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function pad(n) { return String(n).padStart(2, "0"); }

function makeLogEntry(serviceId) {
  const templates = LOG_TEMPLATES[serviceId] || [];
  const tpl = rand(templates);
  if (!tpl) return null;
  const id = Math.floor(Math.random() * 900) + 100;
  const corr = Math.random().toString(36).slice(2, 10);
  const who = rand(["sarah.chen", "karim", "maxime", "ANONYMOUS", "jeroen", "noah.v", "lisa.p"]);
  const amt = (Math.random() * 1500 + 50).toFixed(2);
  const msg = tpl.msg
    .replace(/%ID/g, id)
    .replace(/%CORR/g, corr)
    .replace(/%WHO/g, who)
    .replace(/%AMT/g, amt);
  const now = new Date();
  return {
    id: `${serviceId}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    ts: `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`,
    tsRaw: Date.now(),
    level: tpl.level,
    action: tpl.action,
    msg,
  };
}

// Seed a service with 30-50 backfilled log entries (timestamps spread over last 30 minutes)
function seedLogs(serviceId, count = 40) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const e = makeLogEntry(serviceId);
    if (!e) continue;
    const offsetSec = Math.floor((count - i) * 45 + Math.random() * 30);
    const d = new Date(Date.now() - offsetSec * 1000);
    e.ts = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    e.tsRaw = d.getTime();
    out.push(e);
  }
  return out;
}

function LogsScreen({ levelFilter, setLevelFilter, query, setQuery, themeName }) {
  const [logsBySvc, setLogsBySvc] = React.useState(() => {
    const out = {};
    LOG_SERVICES.forEach((s) => { out[s.id] = seedLogs(s.id, 35); });
    return out;
  });
  const [now, setNow] = React.useState(Date.now());
  const [refreshSecs, setRefreshSecs] = React.useState(0);
  const [paused, setPaused] = React.useState(false);

  // Live stream — push a new log every 1.2s into a random service
  React.useEffect(() => {
    if (paused) return;
    const id = setInterval(() => {
      const svc = rand(LOG_SERVICES).id;
      const entry = makeLogEntry(svc);
      if (!entry) return;
      setLogsBySvc((m) => ({ ...m, [svc]: [entry, ...(m[svc] || [])].slice(0, 200) }));
      setNow(Date.now());
    }, 1200);
    return () => clearInterval(id);
  }, [paused]);

  // refresh-seconds counter
  React.useEffect(() => {
    const id = setInterval(() => setRefreshSecs((s) => (s + 1) % 30), 1000);
    return () => clearInterval(id);
  }, []);

  // Filter logs by level + query
  const filterEntries = (entries) => entries.filter((e) => {
    if (levelFilter !== "any" && e.level !== levelFilter) return false;
    if (query && !e.msg.toLowerCase().includes(query.toLowerCase()) && !e.action.toLowerCase().includes(query.toLowerCase())) return false;
    return true;
  });

  // Aggregate totals
  const totals = React.useMemo(() => {
    let info = 0, warn = 0, err = 0, docs = 0;
    LOG_SERVICES.forEach((s) => {
      const list = logsBySvc[s.id] || [];
      list.forEach((e) => {
        if (e.level === "info") info++;
        else if (e.level === "warning") warn++;
        else if (e.level === "error") err++;
      });
      docs += s.docs;
    });
    return { info, warn, err, docs };
  }, [logsBySvc]);

  return (
    <div className="logs-screen">
      {/* Toolbar */}
      <div className="logs-toolbar">
        <div className="logs-toolbar-left">
          <h1>Live Logs</h1>
          <span className="logs-sub">
            8 services · {totals.docs.toLocaleString()} indexed docs · last 30 days
          </span>
        </div>
        <div className="logs-toolbar-right">
          <div className="logs-search">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            <input
              type="text"
              placeholder="Filter log message or action…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {query && <button className="logs-search-clear" onClick={() => setQuery("")}>×</button>}
          </div>
          <div className="logs-level-pills">
            {["any", "info", "warning", "error"].map((lv) => (
              <button key={lv}
                className={`logs-level-pill ${lv} ${levelFilter === lv ? "is-active" : ""}`}
                onClick={() => setLevelFilter(lv)}
              >
                {lv}
              </button>
            ))}
          </div>
          <button className={`logs-pause ${paused ? "is-paused" : ""}`} onClick={() => setPaused((p) => !p)}>
            {paused ? "▶ Resume" : "❚❚ Pause"}
          </button>
          <span className="logs-refresh mono">
            <span className="dot"></span> refresh in {30 - refreshSecs}s
          </span>
        </div>
      </div>

      {/* KPI summary bar */}
      <div className="logs-kpis">
        <div className="logs-kpi">
          <div className="l">Total documents</div>
          <div className="v mono">{totals.docs.toLocaleString()}</div>
        </div>
        <div className="logs-kpi ok">
          <div className="l">Info events (visible)</div>
          <div className="v mono">{totals.info}</div>
        </div>
        <div className="logs-kpi warn">
          <div className="l">Warnings</div>
          <div className="v mono">{totals.warn}</div>
        </div>
        <div className="logs-kpi hot">
          <div className="l">Errors</div>
          <div className="v mono">{totals.err}</div>
        </div>
      </div>

      {/* Service panels — 2-column grid */}
      <div className="logs-grid">
        {LOG_SERVICES.map((s) => (
          <LogPanel key={s.id} svc={s} logs={filterEntries(logsBySvc[s.id] || [])} totalDocs={s.docs} now={now} />
        ))}
      </div>
    </div>
  );
}

function LogPanel({ svc, logs, totalDocs, now }) {
  const stats = STATS[svc.id] || [];
  const shown = logs.slice(0, 12);

  return (
    <div className="log-panel" data-svc={svc.svc}>
      <div className="log-panel-head">
        <span className="log-panel-icon">{svc.label[0]}</span>
        <h3>{svc.label}</h3>
        <span className="log-panel-docs mono">{totalDocs.toLocaleString()} docs</span>
        <span className="log-panel-live"><span className="dot"></span>live</span>
      </div>

      <div className="log-panel-body">
        {/* Left: stats breakdown */}
        <div className="log-stats">
          <div className="log-stats-head">
            <span>level</span><span>action</span><span style={{ textAlign: "right" }}># logs</span>
          </div>
          {stats.map((row, i) => (
            <div key={i} className="log-stats-row">
              <span className={`log-lvl ${row.level}`}>{row.level}</span>
              <span className="log-stats-action mono">{row.action}</span>
              <span className="log-stats-count mono">{row.count.toLocaleString()}</span>
            </div>
          ))}
        </div>

        {/* Right: live log entries */}
        <div className="log-stream">
          <div className="log-stream-head">
            <span style={{ width: 78 }}>@timestamp</span>
            <span style={{ width: 64 }}>level</span>
            <span style={{ width: 110 }}>action</span>
            <span style={{ flex: 1 }}>log_message</span>
          </div>
          <div className="log-stream-body">
            {shown.length === 0 && (
              <div className="log-empty mono">no entries match the filter</div>
            )}
            {shown.map((e, idx) => {
              const fresh = (now - e.tsRaw) < 4000;
              return (
                <div key={e.id} className={`log-line ${e.level} ${fresh ? "fresh" : ""}`}>
                  <span className="log-ts mono">{e.ts}</span>
                  <span className={`log-lvl ${e.level}`}>{e.level}</span>
                  <span className="log-action mono">{e.action}</span>
                  <span className="log-msg mono">{e.msg}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { LogsScreen });
