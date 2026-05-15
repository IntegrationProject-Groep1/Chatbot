/* eslint-disable no-undef */
/* ============================================================
   Logs Screen — fullscreen live monitoring view
   Polls /api/monitoring/errors (Monitoring MCP) every 30s.
   ============================================================ */

const LOG_SERVICES = [
  { id: "kassa",      label: "Kassa",      svc: "kassa"      },
  { id: "facturatie", label: "Facturatie", svc: "facturatie" },
  { id: "crm",        label: "CRM",        svc: "crm"        },
  { id: "frontend",   label: "Frontend",   svc: "frontend"   },
  { id: "monitoring", label: "Monitoring", svc: "monitoring" },
];

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

function groupBySource(errors) {
  const out = {};
  errors.forEach((e) => {
    const src = (e.source || "unknown").toLowerCase();
    if (!out[src]) out[src] = [];
    out[src].push({
      id: e.correlation_id || `${src}-${e["@timestamp"] || Math.random()}`,
      ts: tsFromIso(e["@timestamp"]),
      tsRaw: tsRawFromIso(e["@timestamp"]),
      level: (e.level || "info").toLowerCase(),
      action: e.action || "—",
      msg: e.message || "",
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

function LogsScreen({ levelFilter, setLevelFilter, query, setQuery, themeName }) {
  const [logsBySvc, setLogsBySvc] = React.useState({});
  const [loading, setLoading] = React.useState(true);
  const [paused, setPaused] = React.useState(false);
  const [refreshSecs, setRefreshSecs] = React.useState(0);
  const [now, setNow] = React.useState(Date.now());

  const fetchLogs = React.useCallback(() => {
    fetch("/api/monitoring/errors?limit=100")
      .then((r) => r.json())
      .then((d) => {
        const grouped = groupBySource(d.errors || []);
        setLogsBySvc(grouped);
        setNow(Date.now());
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  React.useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  React.useEffect(() => {
    if (paused) return;
    const id = setInterval(() => {
      fetchLogs();
      setRefreshSecs(0);
    }, 30000);
    return () => clearInterval(id);
  }, [paused, fetchLogs]);

  React.useEffect(() => {
    const id = setInterval(() => setRefreshSecs((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const filterEntries = (entries) =>
    entries.filter((e) => {
      if (levelFilter !== "any" && e.level !== levelFilter) return false;
      if (
        query &&
        !e.msg.toLowerCase().includes(query.toLowerCase()) &&
        !e.action.toLowerCase().includes(query.toLowerCase())
      )
        return false;
      return true;
    });

  const totals = React.useMemo(() => {
    let info = 0, warn = 0, err = 0, total = 0;
    Object.values(logsBySvc).forEach((list) => {
      list.forEach((e) => {
        total++;
        if (e.level === "info") info++;
        else if (e.level === "warning" || e.level === "warn") warn++;
        else if (e.level === "error") err++;
      });
    });
    return { info, warn, err, total };
  }, [logsBySvc]);

  return (
    <div className="logs-screen">
      {/* Toolbar */}
      <div className="logs-toolbar">
        <div className="logs-toolbar-left">
          <h1>Live Logs</h1>
          <span className="logs-sub">
            Monitoring MCP · {totals.total} entries fetched · real-time
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
              <button
                key={lv}
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
            <span className="dot"></span>
            {paused ? "paused" : `refresh in ${Math.max(0, 30 - refreshSecs)}s`}
          </span>
        </div>
      </div>

      {/* KPI summary bar */}
      <div className="logs-kpis">
        <div className="logs-kpi">
          <div className="l">Total entries</div>
          <div className="v mono">{totals.total}</div>
        </div>
        <div className="logs-kpi ok">
          <div className="l">Info</div>
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

      {loading && (
        <div style={{ padding: "32px", textAlign: "center", color: "var(--muted-2)", fontFamily: "var(--font-mono)", fontSize: 12 }}>
          Loading logs from Monitoring MCP…
        </div>
      )}

      {/* Service panels — 2-column grid */}
      {!loading && (
        <div className="logs-grid">
          {LOG_SERVICES.map((s) => (
            <LogPanel
              key={s.id}
              svc={s}
              logs={filterEntries(logsBySvc[s.id] || [])}
              allLogs={logsBySvc[s.id] || []}
              now={now}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function LogPanel({ svc, logs, allLogs, now }) {
  const stats = computeStats(allLogs);
  const shown = logs.slice(0, 12);

  return (
    <div className="log-panel" data-svc={svc.svc}>
      <div className="log-panel-head">
        <span className="log-panel-icon">{svc.label[0]}</span>
        <h3>{svc.label}</h3>
        <span className="log-panel-docs mono">{allLogs.length} entries</span>
        <span className="log-panel-live"><span className="dot"></span>live</span>
      </div>

      <div className="log-panel-body">
        {/* Left: stats breakdown */}
        <div className="log-stats">
          <div className="log-stats-head">
            <span>level</span><span>action</span><span style={{ textAlign: "right" }}>#</span>
          </div>
          {stats.length === 0 && (
            <div style={{ padding: "8px 4px", fontSize: 10, color: "var(--muted-2)", fontFamily: "var(--font-mono)" }}>
              no data
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
              <div className="log-empty mono">
                {allLogs.length === 0 ? "no entries from Monitoring MCP" : "no entries match the filter"}
              </div>
            )}
            {shown.map((e, idx) => {
              const fresh = now - e.tsRaw < 60000;
              return (
                <div key={e.id || idx} className={`log-line ${e.level} ${fresh ? "fresh" : ""}`}>
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
