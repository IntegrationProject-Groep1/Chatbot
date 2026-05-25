/* eslint-disable no-undef */
/* ============================================================
   Logs Screen — live monitoring with historical time-range browsing.
   Live mode: polls /api/logs/query every 10s, rolling 300 entries.
   Historical mode: fetches once per selection, reads from DB or MCP.
   ============================================================ */

const LOG_SERVICES = [
  { id: "kassa",           label: "Kassa"      },
  { id: "facturatie",      label: "Facturatie" },
  { id: "crm",             label: "CRM"        },
  { id: "frontend",        label: "Frontend"   },
  { id: "planning",        label: "Planning"   },
  { id: "mailing",         label: "Mailing"    },
  { id: "identity-service",label: "Identity"   },
  { id: "monitoring",      label: "Monitoring" },
];

const TIME_MODES = [
  { id: "live", label: "Live",   hours: null  },
  { id: "15m",  label: "15 min", hours: 0.25  },
  { id: "1h",   label: "1 uur",  hours: 1     },
  { id: "6h",   label: "6 uur",  hours: 6     },
  { id: "7h",   label: "7 uur",  hours: 7     },
];

const LIVE_LIMIT  = 300;
const LIVE_POLL   = 10000; // ms

function pad(n) { return String(n).padStart(2, "0"); }

function tsFromIso(iso) {
  if (!iso) return "--:--:--";
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function tsRawFromIso(iso) {
  if (!iso) return 0;
  return new Date(iso).getTime();
}

// Maps raw source values from MCP logs to canonical LOG_SERVICES ids.
const SOURCE_ALIAS = {
  "user":         "planning",
  "registration": "identity-service",
};

function groupBySource(logs) {
  const out = {};
  const counters = {};
  logs.forEach((e) => {
    const raw = (e.source || e.system || "unknown").toLowerCase();
    const src = SOURCE_ALIAS[raw] ?? raw;
    if (!out[src]) { out[src] = []; counters[src] = 0; }
    counters[src]++;
    out[src].push({
      id:     e.correlation_id || `${src}-${e["@timestamp"] || Math.random()}-${counters[src]}`,
      ts:     tsFromIso(e["@timestamp"]),
      tsRaw:  tsRawFromIso(e["@timestamp"]),
      level:  (e.level  || "info").toLowerCase(),
      action: e.action  || "—",
      msg:    e.message || e.log_message || "",
    });
  });
  return out;
}

function computeStats(entries) {
  const byAction = {};
  entries.forEach((e) => {
    const key = `${e.level}::${e.action}`;
    if (!byAction[key]) byAction[key] = { level: e.level, action: e.action, count: 0 };
    byAction[key].count++;
  });
  return Object.values(byAction).sort((a, b) => b.count - a.count).slice(0, 6);
}

// ── ACTION labels (NL) ────────────────────────────────────────────────────────
const ACTION_NL = {
  registration: "Registratie", payment: "Betaling", invoice: "Factuur",
  session: "Sessie", calendar: "Agenda", email: "E-mail", wallet: "Wallet",
  badge: "Badge", user: "Gebruiker", refund: "Terugbetaling",
  xml_validation: "XML-validatie", system_error: "Systeemfout", identity: "Identity",
};

// ── Dashboard strip ────────────────────────────────────────────────────────────
function LogsDashboard({ logsBySvc, totals, timeMode, onSvcClick, svcFilter }) {
  // Per-service breakdown
  const svcStats = React.useMemo(() => {
    return LOG_SERVICES.map(s => {
      const entries = logsBySvc[s.id] || [];
      const errors  = entries.filter(e => e.level === "error").length;
      const warns   = entries.filter(e => e.level === "warning" || e.level === "warn").length;
      return { ...s, total: entries.length, errors, warns, ok: entries.length - errors - warns };
    }).sort((a, b) => b.total - a.total);
  }, [logsBySvc]);

  // Top actions across all services
  const topActions = React.useMemo(() => {
    const counts = {};
    Object.values(logsBySvc).flat().forEach(e => {
      counts[e.action] = (counts[e.action] || 0) + 1;
    });
    return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 6);
  }, [logsBySvc]);

  const errorRate  = totals.total > 0 ? Math.round(totals.err / totals.total * 100) : 0;
  const maxSvcTotal = Math.max(1, ...svcStats.map(s => s.total));
  const activeServices = svcStats.filter(s => s.total > 0).length;

  return (
    <div className="logs-dash">
      {/* ── KPI tiles ── */}
      <div className="logs-dash-kpis">
        <div className="logs-kpi">
          <span className="logs-kpi-v">{totals.total}</span>
          <span className="logs-kpi-l">entries</span>
        </div>
        <div className={`logs-kpi ${activeServices > 0 ? "" : "muted"}`}>
          <span className="logs-kpi-v">{activeServices}</span>
          <span className="logs-kpi-l">actieve services</span>
        </div>
        <div className={`logs-kpi ${totals.err > 0 ? "hot" : ""}`}>
          <span className="logs-kpi-v">{totals.err}</span>
          <span className="logs-kpi-l">errors</span>
        </div>
        <div className={`logs-kpi ${totals.warn > 0 ? "warn" : ""}`}>
          <span className="logs-kpi-v">{totals.warn}</span>
          <span className="logs-kpi-l">warnings</span>
        </div>
        <div className={`logs-kpi ${errorRate > 10 ? "hot" : errorRate > 0 ? "warn" : ""}`}>
          <span className="logs-kpi-v">{errorRate}%</span>
          <span className="logs-kpi-l">foutpercentage</span>
        </div>

        {topActions.length > 0 && (
          <div className="logs-dash-actions">
            <span className="logs-dash-actions-lbl">Top acties</span>
            <div className="logs-dash-action-chips">
              {topActions.map(([action, count]) => (
                <span key={action} className="logs-dash-action-chip">
                  {ACTION_NL[action] || action}
                  <b>{count}</b>
                </span>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* ── Service activity bars ── */}
      {svcStats.some(s => s.total > 0) && (
        <div className="logs-dash-bars">
          {svcStats.map(s => {
            const pct     = s.total / maxSvcTotal;
            const errPct  = s.total > 0 ? s.errors / s.total : 0;
            const warnPct = s.total > 0 ? s.warns  / s.total : 0;
            const okPct   = 1 - errPct - warnPct;
            const hasErr  = s.errors > 0;
            return (
              <button key={s.id}
                className={`logs-dash-bar ${s.total === 0 ? "idle" : ""} ${hasErr ? "has-err" : ""} ${svcFilter === s.id ? "is-active" : ""}`}
                onClick={() => onSvcClick(s.id)}
                title={`${s.label}: ${s.total} entries, ${s.errors} fouten`}>
                <span className="logs-dash-bar-label">{s.label}</span>
                <div className="logs-dash-bar-track">
                  <div className="logs-dash-bar-fill ok"   style={{ width: `${okPct   * pct * 100}%` }} />
                  <div className="logs-dash-bar-fill warn" style={{ width: `${warnPct * pct * 100}%` }} />
                  <div className="logs-dash-bar-fill hot"  style={{ width: `${errPct  * pct * 100}%` }} />
                </div>
                <span className={`logs-dash-bar-count ${hasErr ? "hot" : ""}`}>
                  {s.total > 0 ? s.total : "—"}
                  {s.errors > 0 && <span className="logs-dash-bar-err"> · {s.errors}✕</span>}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function LogsScreen({ levelFilter, setLevelFilter, query, setQuery }) {
  const [timeMode, setTimeMode]   = React.useState("live");
  const [svcFilter, setSvcFilter] = React.useState("all");
  const [logsBySvc, setLogsBySvc] = React.useState({});
  const [loading, setLoading]     = React.useState(true);
  const [paused, setPaused]       = React.useState(false);
  const [countdown, setCountdown] = React.useState(0);
  const [now, setNow]             = React.useState(Date.now());
  const [liveError, setLiveError] = React.useState(null);
  const [dataSource, setDataSource] = React.useState("live");

  const buildUrl = React.useCallback(() => {
    const p = new URLSearchParams();
    p.set("limit", LIVE_LIMIT);
    const mode = TIME_MODES.find(m => m.id === timeMode);
    const isHistorical = mode && mode.hours !== null;
    if (isHistorical) {
      p.set("hours", mode.hours);
      // Only push service filter to API for historical queries — live always fetches
      // all services and filters client-side to avoid count mismatches.
      if (svcFilter !== "all") p.set("service", svcFilter);
    } else {
      // Live mode: cap at 15 minutes so the API only returns the rolling window.
      p.set("hours", "0.25");
    }
    if (levelFilter !== "any") p.set("level", levelFilter);
    return `/api/logs/query?${p}`;
  }, [timeMode, svcFilter, levelFilter]);

  const fetchLogs = React.useCallback(() => {
    fetch(buildUrl())
      .then(r => r.json())
      .then(d => {
        setLogsBySvc(groupBySource(d.logs || []));
        setNow(Date.now());
        setLoading(false);
        setLiveError(d.error || null);
        setDataSource(d.source || "live");
        if (timeMode === "live") setCountdown(LIVE_POLL / 1000);
      })
      .catch(() => { setLoading(false); setLiveError("Verbinding mislukt — logs tijdelijk niet beschikbaar"); });
  }, [buildUrl, timeMode]);

  // Fetch whenever mode or filters change
  React.useEffect(() => {
    setLoading(true);
    fetchLogs();
  }, [timeMode, svcFilter, levelFilter]);

  // Live polling
  React.useEffect(() => {
    if (timeMode !== "live" || paused) return;
    const id = setInterval(fetchLogs, LIVE_POLL);
    return () => clearInterval(id);
  }, [timeMode, paused, fetchLogs]);

  // Countdown ticker
  React.useEffect(() => {
    if (timeMode !== "live" || paused) return;
    const id = setInterval(() => setCountdown(c => Math.max(0, c - 1)), 1000);
    return () => clearInterval(id);
  }, [timeMode, paused]);

  const filterEntries = (entries) =>
    entries.filter(e => {
      if (levelFilter !== "any" && e.level !== levelFilter) return false;
      if (query && !e.msg.toLowerCase().includes(query.toLowerCase()) &&
          !e.action.toLowerCase().includes(query.toLowerCase())) return false;
      return true;
    });

  const totals = React.useMemo(() => {
    let info = 0, warn = 0, err = 0, total = 0;
    const svcIds = svcFilter === "all" ? LOG_SERVICES.map(s => s.id) : [svcFilter];
    svcIds.forEach(svcId => {
      filterEntries(logsBySvc[svcId] || []).forEach(e => {
        total++;
        if (e.level === "info") info++;
        else if (e.level === "warning" || e.level === "warn") warn++;
        else if (e.level === "error") err++;
      });
    });
    return { info, warn, err, total };
  }, [logsBySvc, svcFilter, query, levelFilter]);

  const visibleServices = svcFilter === "all"
    ? LOG_SERVICES
    : LOG_SERVICES.filter(s => s.id === svcFilter);

  const isLive = timeMode === "live";

  return (
    <div className="logs-screen">

      {/* ── Toolbar ── */}
      <div className="logs-toolbar">
        <div className="logs-toolbar-left">
          <h1>{isLive ? "Live Logs" : "Historische Logs"}</h1>
          <span className="logs-sub">
            {dataSource === "cache" ? "cached · " : ""}
            {totals.total} entries
            {isLive ? " · live" : ` · ${TIME_MODES.find(m => m.id === timeMode)?.label}`}
          </span>
        </div>
        <div className="logs-toolbar-right">
          <div className="logs-search">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            <input
              type="text"
              placeholder="Zoek in bericht of actie…"
              value={query}
              onChange={e => setQuery(e.target.value)}
            />
            {query && <button className="logs-search-clear" onClick={() => setQuery("")}>×</button>}
          </div>
          <div className="logs-level-pills">
            {["any", "info", "warning", "error"].map(lv => (
              <button
                key={lv}
                className={`logs-level-pill ${lv} ${levelFilter === lv ? "is-active" : ""}`}
                onClick={() => setLevelFilter(lv)}
              >{lv}</button>
            ))}
          </div>
          {isLive && (
            <button className={`logs-pause ${paused ? "is-paused" : ""}`} onClick={() => setPaused(p => !p)}>
              {paused ? "▶ Hervatten" : "❚❚ Pauzeren"}
            </button>
          )}
          <span className="logs-refresh mono">
            <span className="dot"></span>
            {!isLive ? "historisch" : paused ? "gepauzeerd" : `${countdown}s`}
          </span>
        </div>
      </div>

      {/* ── Time mode + service filter bar ── */}
      <div className="logs-filter-bar">
        <div className="logs-time-modes">
          {TIME_MODES.map(m => (
            <button
              key={m.id}
              className={`logs-time-btn ${timeMode === m.id ? "is-active" : ""} ${m.id === "live" ? "is-live" : ""}`}
              onClick={() => { setTimeMode(m.id); setPaused(false); }}
            >
              {m.id === "live" && <span className="dot"></span>}
              {m.label}
            </button>
          ))}
        </div>
        <div className="logs-svc-filter">
          <button
            className={`logs-svc-btn ${svcFilter === "all" ? "is-active" : ""}`}
            onClick={() => setSvcFilter("all")}
          >Alle</button>
          {LOG_SERVICES.map(s => (
            <button
              key={s.id}
              className={`logs-svc-btn ${svcFilter === s.id ? "is-active" : ""}`}
              onClick={() => setSvcFilter(svcFilter === s.id ? "all" : s.id)}
            >{s.label}</button>
          ))}
        </div>
      </div>

      {/* ── Dashboard ── */}
      {!loading && (
        <LogsDashboard
          logsBySvc={logsBySvc}
          totals={totals}
          timeMode={timeMode}
          svcFilter={svcFilter}
          onSvcClick={(id) => setSvcFilter(svcFilter === id ? "all" : id)}
        />
      )}

      {/* ── Error banner ── */}
      {liveError && (
        <div className="logs-error-banner">{liveError}</div>
      )}

      {loading && (
        <div style={{ padding: "32px", textAlign: "center", color: "var(--muted-2)", fontFamily: "var(--font-mono)", fontSize: 12 }}>
          {isLive ? "Logs ophalen…" : "Historische logs ophalen…"}
        </div>
      )}

      {/* ── Service panels grid ── */}
      {!loading && (
        <div className={`logs-grid ${svcFilter !== "all" ? "logs-grid-single" : ""}`}>
          {visibleServices.map(s => (
            <LogPanel
              key={s.id}
              svc={s}
              logs={filterEntries(logsBySvc[s.id] || [])}
              allLogs={logsBySvc[s.id] || []}
              now={now}
              isLive={isLive}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function LogPanel({ svc, logs, allLogs, now, isLive }) {
  const [showAll, setShowAll] = React.useState(false);
  const stats  = computeStats(allLogs);
  const shown  = showAll ? logs : logs.slice(0, 15);

  return (
    <div className="log-panel" data-svc={svc.id}>
      <div className="log-panel-head">
        <span className="log-panel-icon">{svc.label[0]}</span>
        <h3>{svc.label}</h3>
        <span className="log-panel-docs mono">{allLogs.length} entries</span>
        {isLive && <span className="log-panel-live"><span className="dot"></span>live</span>}
      </div>

      <div className="log-panel-body">
        {/* Left: breakdown */}
        <div className="log-stats">
          <div className="log-stats-head">
            <span>level</span><span>action</span><span style={{ textAlign: "right" }}>#</span>
          </div>
          {stats.length === 0 && (
            <div style={{ padding: "8px 4px", fontSize: 10, color: "var(--muted-2)", fontFamily: "var(--font-mono)" }}>
              geen data
            </div>
          )}
          {stats.map((row, i) => (
            <div key={i} className="log-stats-row">
              <span className={`log-lvl ${row.level}`}>{row.level}</span>
              <span className="log-stats-action mono">{row.action}</span>
              <span className="log-stats-count mono">{row.count}</span>
            </div>
          ))}
        </div>

        {/* Right: log stream */}
        <div className="log-stream">
          <div className="log-stream-head">
            <span style={{ width: 78 }}>@timestamp</span>
            <span style={{ width: 64 }}>level</span>
            <span style={{ width: 110 }}>action</span>
            <span style={{ flex: 1 }}>log_message</span>
          </div>
          <div className="log-stream-body" style={{ overflowY: "auto", maxHeight: 320 }}>
            {shown.length === 0 && (
              <div className="log-empty mono">
                {allLogs.length === 0 ? "geen entries" : "geen entries voor dit filter"}
              </div>
            )}
            {shown.map((e, idx) => {
              const fresh = now - e.tsRaw < 60000;
              return (
                <div key={`${e.id}-${idx}`} className={`log-line ${e.level} ${fresh && isLive ? "fresh" : ""}`}
                  style={{ alignItems: "flex-start" }}>
                  <span className="log-ts mono" style={{ flexShrink: 0 }}>{e.ts}</span>
                  <span className={`log-lvl ${e.level}`} style={{ flexShrink: 0 }}>{e.level}</span>
                  <span className="log-action mono" style={{ flexShrink: 0 }}>{e.action}</span>
                  <span className="log-msg mono" title={e.msg}
                    style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", flex: 1 }}>{e.msg}</span>
                </div>
              );
            })}
          </div>
          {!showAll && logs.length > 15 && (
            <button className="log-show-more" onClick={() => setShowAll(true)}>
              ↓ Nog {logs.length - 15} meer tonen
            </button>
          )}
          {showAll && logs.length > 15 && (
            <button className="log-show-more" onClick={() => setShowAll(false)}>
              ↑ Minder tonen
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { LogsScreen });
