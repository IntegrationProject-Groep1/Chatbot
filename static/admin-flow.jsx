/* eslint-disable no-undef */
/* ============================================================
   MCP Topology — permanently visible flow visualizer
   ============================================================ */
const { useEffect, useMemo, useRef, useState } = React;

// MCP server node ids — used to detect "disconnected" state
const MCP_NODE_IDS = new Set(["frontend", "facturatie", "crm", "kassa", "monitoring"]);

function FlowTopology({ activeNodes, doneNodes, activeEdges, connectedServers = new Set() }) {
  // Build edge data once
  const edges = useMemo(() => {
    return EDGES.map(([from, to, label]) => {
      const a = NODES[from];
      const b = NODES[to];
      // Anchor at node center horizontally and at top/bottom edges vertically
      const nodeW = 130;
      const nodeH = 36;
      const ax = a.x + nodeW / 2;
      const bx = b.x + nodeW / 2;
      const ay = a.y + nodeH;          // bottom of `from`
      const by = b.y;                   // top of `to`

      // Curve control points: vertical bend with smooth S
      const dy = Math.abs(by - ay);
      const c1y = ay + dy * 0.55;
      const c2y = by - dy * 0.55;
      const path = `M ${ax} ${ay} C ${ax} ${c1y}, ${bx} ${c2y}, ${bx} ${by}`;

      return { from, to, label, path, ax, ay, bx, by };
    });
  }, []);

  // Animate traveling dots on active edges
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (activeEdges.size === 0) return;
    let raf;
    const start = performance.now();
    const loop = (t) => {
      setTick(((t - start) % 1600) / 1600);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [activeEdges.size]);

  return (
    <div className="flow-canvas">
      <svg viewBox={`0 0 ${FLOW_W} ${FLOW_H}`} preserveAspectRatio="xMidYMid meet">
        <defs>
          <marker id="arr-idle" viewBox="0 0 10 10" refX="9" refY="5"
            markerWidth="5" markerHeight="5" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#8B93A8" />
          </marker>
          <marker id="arr-active" viewBox="0 0 10 10" refX="9" refY="5"
            markerWidth="5" markerHeight="5" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#1F3A8A" />
          </marker>
          <linearGradient id="edge-active" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#1F3A8A" stopOpacity="0.45" />
            <stop offset="100%" stopColor="#1F3A8A" stopOpacity="0.95" />
          </linearGradient>
        </defs>

        {/* Group brackets for MCP servers row */}
        <g>
          <rect x="14" y="305" width={FLOW_W - 28} height="155"
            rx="14" ry="14"
            fill="rgba(243,244,250,0.55)"
            stroke="#E5E8F0"
            strokeDasharray="4 4" />
          <rect x="28" y="297" width="92" height="16" rx="3" fill="#F2F4FA" />
          <text x="36" y="308"
            fontFamily="JetBrains Mono, monospace"
            fontSize="9.5"
            letterSpacing="0.12em"
            fill="#5B6480"
            fontWeight="600">
            MCP SERVERS
          </text>
        </g>

        {/* Edges */}
        {edges.map((e) => {
          const key = `${e.from}->${e.to}`;
          const isActive = activeEdges.has(key);
          return (
            <g key={key}>
              <path
                d={e.path}
                fill="none"
                stroke={isActive ? "url(#edge-active)" : "#DADEEC"}
                strokeWidth={isActive ? 2 : 1.2}
                strokeDasharray={isActive ? "0" : "5 4"}
                markerEnd={isActive ? "url(#arr-active)" : "url(#arr-idle)"}
                style={{ transition: "stroke 300ms, stroke-width 300ms" }}
              />
              <EdgeLabel path={e.path} label={e.label} active={isActive} />
              {isActive && <TravelingDot path={e.path} t={tick} />}
            </g>
          );
        })}

        {/* Nodes as foreignObject so they share the SVG coordinate system */}
        {Object.entries(NODES).map(([id, n]) => {
          const active = activeNodes.has(id);
          const done = doneNodes.has(id) && !active;
          // MCP server nodes that didn't load are marked disconnected
          const disconnected = MCP_NODE_IDS.has(id) && connectedServers.size > 0 && !connectedServers.has(id);
          return (
            <foreignObject key={id}
              x={n.x} y={n.y} width="130" height="44"
              style={{ overflow: "visible" }}>
              <div
                xmlns="http://www.w3.org/1999/xhtml"
                className={`fnode-html ${active ? "is-active" : ""} ${done ? "is-done" : ""} ${n.llama ? "is-llama" : ""}`}
                data-svc={n.svc}
                style={{
                  width: "130px",
                  opacity: disconnected ? 0.38 : 1,
                  filter: disconnected ? "grayscale(0.7)" : "none",
                  transition: "opacity 0.4s, filter 0.4s",
                }}
                title={disconnected ? `${n.label} — not connected` : undefined}
              >
                <div className="dot" style={disconnected ? { background: "var(--muted-2)" } : {}}>
                  {disconnected ? "×" : n.icon}
                </div>
                <div className="text">
                  <span className="name">{n.label}</span>
                  <span className="meta">{disconnected ? "not connected" : n.meta}</span>
                </div>
              </div>
            </foreignObject>
          );
        })}
      </svg>
    </div>
  );
}

function EdgeLabel({ path, label, active }) {
  const ref = useRef(null);
  const [pos, setPos] = useState(null);
  useEffect(() => {
    if (ref.current) {
      const len = ref.current.getTotalLength();
      const p = ref.current.getPointAtLength(len / 2);
      setPos(p);
    }
  }, [path]);

  const w = label.length * 5.8 + 10;
  return (
    <>
      <path ref={ref} d={path} fill="none" stroke="none" />
      {pos && (
        <g transform={`translate(${pos.x}, ${pos.y})`}>
          <rect x={-w / 2} y={-7} width={w} height="14" rx="3"
            fill={active ? "#EEF1F9" : "#FAFBFD"}
            stroke={active ? "#D7DEF0" : "#E5E8F0"}
          />
          <text x={0} y={3}
            textAnchor="middle"
            fontFamily="JetBrains Mono, monospace"
            fontSize="9"
            fill={active ? "#1F3A8A" : "#5B6480"}
            fontWeight="600">
            {label}
          </text>
        </g>
      )}
    </>
  );
}

function TravelingDot({ path, t }) {
  const ref = useRef(null);
  const [pos, setPos] = useState(null);
  useEffect(() => {
    if (ref.current) {
      const len = ref.current.getTotalLength();
      const p = ref.current.getPointAtLength(len * t);
      setPos(p);
    }
  }, [t, path]);
  return (
    <>
      <path ref={ref} d={path} fill="none" stroke="none" />
      {pos && (
        <>
          <circle cx={pos.x} cy={pos.y} r="7" fill="#1F3A8A" fillOpacity="0.18" />
          <circle cx={pos.x} cy={pos.y} r="3.5" fill="#1F3A8A" />
        </>
      )}
    </>
  );
}

function MCPServerList() {
  const [servers, setServers] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/mcp/tools")
      .then(r => r.json())
      .then(d => { setServers(d.servers || []); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  if (loading) return (
    <div style={{ padding: "20px 14px", fontSize: 11, color: "var(--muted-2)", fontFamily: "var(--font-mono)" }}>
      Loading MCP tools…
    </div>
  );
  if (!servers.length) return (
    <div style={{ padding: "20px 14px", fontSize: 11, color: "var(--muted-2)", fontFamily: "var(--font-mono)" }}>
      No MCP servers connected. Check MCP_SERVERS env var.
    </div>
  );

  return (
    <div style={{ padding: "12px 14px", display: "flex", flexDirection: "column", gap: 6, overflowY: "auto" }}>
      {servers.map((s) => (
        <div key={s.id}
          className="fnode-html"
          data-svc={s.id}
          style={{ width: "100%", padding: "8px 10px" }}
        >
          <div className="dot">{s.id[0].toUpperCase()}</div>
          <div className="text" style={{ flex: 1 }}>
            <span className="name" style={{ textTransform: "capitalize" }}>{s.id}</span>
            <span className="meta">{s.count} tool{s.count !== 1 ? "s" : ""} loaded</span>
          </div>
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap", justifyContent: "flex-end", maxWidth: 180 }}>
            {(s.tools || []).slice(0, 2).map((t) => (
              <span key={t} className="mono" style={{
                fontSize: 9.5, padding: "1px 6px", borderRadius: 999,
                background: "var(--surface-2)", border: "1px solid var(--line)",
                color: "var(--muted)",
              }}>{t}</span>
            ))}
            {(s.tools || []).length > 2 && (
              <span className="mono" style={{
                fontSize: 9.5, padding: "1px 6px", borderRadius: 999,
                background: "var(--surface-3)", color: "var(--muted)",
              }}>+{s.tools.length - 2}</span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------- Monitoring panel: live data from /api/monitoring/status ----------
function _secsSince(ts) {
  if (!ts) return null;
  return Math.round((Date.now() - new Date(ts).getTime()) / 1000);
}

function _uptimeLabel(seconds) {
  if (seconds == null) return "—";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

function _sinceLabel(secs) {
  if (secs == null) return "—";
  if (secs < 5)    return `${secs}s ago`;
  if (secs < 60)   return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  return `${Math.floor(secs / 3600)}h ago`;
}

function MonitoringPanel() {
  const [services, setServices] = useState([]);
  const [lastRefresh, setLastRefresh] = useState(null);
  const [error, setError] = useState(null);
  const [tick, setTick] = useState(0);
  const [selected, setSelected] = useState(null);

  const fetchStatus = () => {
    fetch("/api/monitoring/status")
      .then(r => r.json())
      .then(d => {
        if (d.error) { setError(d.error); return; }
        setServices(d.services || []);
        setLastRefresh(new Date());
        setError(null);
      })
      .catch(e => setError(e.message));
  };

  useEffect(() => {
    fetchStatus();
    const poll = setInterval(fetchStatus, 5000);
    const anim = setInterval(() => setTick(t => t + 1), 1000);
    return () => { clearInterval(poll); clearInterval(anim); };
  }, []);

  // Normalise status: live=false overrides any stored status value
  const normalise = (s) => {
    if (!s.live) {
      if ((s.status || "").toLowerCase() === "no_data") return "unknown";
      return "quarantine";
    }
    const st = (s.status || "unknown").toLowerCase();
    if (st === "online" || st === "up" || st === "healthy") return "online";
    if (st === "degraded" || st === "slow") return "degraded";
    return "unknown";
  };

  const _svcLabel = { "identity-service": "Identity", "iot_gateway": "IoT Gateway" };
  const normed = services.map(s => ({
    id: s.service,
    label: _svcLabel[s.service] || (s.service.charAt(0).toUpperCase() + s.service.slice(1)),
    status: normalise(s),
    uptime: _uptimeLabel(s.uptime_seconds),
    lastSeen: _secsSince(s.last_seen),
  }));

  const online     = normed.filter(s => s.status === "online").length;
  const degraded   = normed.filter(s => s.status === "degraded").length;
  const quarantined = normed.filter(s => s.status === "quarantine").length;
  const unknown    = normed.filter(s => s.status === "unknown").length;

  const overallStatus = (quarantined > 0 || unknown > 0) ? "hot"
                      : degraded > 0 ? "warn" : "ok";
  const summaryLabel = overallStatus === "ok"
    ? "All systems operational"
    : overallStatus === "warn"
      ? `${degraded} degraded · ${online} online`
      : `${quarantined} offline · ${degraded} degraded`;

  return (
    <div className="mon-pane">
      <div className={`mon-hero ${overallStatus}`}>
        <div className="mon-hero-dot"></div>
        <div className="mon-hero-text">
          <b>{error ? "Monitoring MCP unavailable" : summaryLabel}</b>
          <span>
            {error
              ? <span style={{ color: "var(--hot)", fontSize: 10 }}>{error.slice(0, 60)}</span>
              : <span>Last updated <span className="mono">{lastRefresh ? lastRefresh.toLocaleTimeString([], { hour12: false }) : "—"}</span> · polling every 5s</span>
            }
          </span>
        </div>
        <span className="mon-hero-time mono">{new Date().toLocaleTimeString([], { hour12: false })}</span>
      </div>

      <div className="mon-kpis">
        <div className="mon-kpi">
          <div className="v mono">{normed.length}</div>
          <div className="l">Services</div>
        </div>
        <div className="mon-kpi">
          <div className="v mono ok">{online}</div>
          <div className="l">Online</div>
        </div>
        <div className="mon-kpi">
          <div className="v mono warn">{degraded}</div>
          <div className="l">Degraded</div>
        </div>
        <div className="mon-kpi">
          <div className="v mono hot">{quarantined}</div>
          <div className="l">Offline</div>
        </div>
      </div>

      <div className="mon-list">
        <div className="mon-list-head">
          <span>Service</span>
          <span>Heartbeat · last 60s</span>
          <span style={{ textAlign: "right" }}>Status</span>
        </div>
        {normed.length === 0 && !error && (
          <div style={{ padding: "16px 14px", fontSize: 11, color: "var(--muted-2)", fontFamily: "var(--font-mono)" }}>
            {lastRefresh ? "No heartbeats received yet." : "Loading…"}
          </div>
        )}
        {normed.map((s) => (
          <MonRow key={s.id} svc={s} tick={tick} onOpen={() => setSelected(s)} />
        ))}
      </div>

      <div className="mon-footer">
        <span className="mono" style={{ color: "var(--muted-2)" }}>
          source: heartbeats-* via Monitoring MCP · {normed.length} services
        </span>
        <button className="mon-link mono" onClick={fetchStatus}>Refresh now →</button>
      </div>

      {selected && (
        <ServiceDetailDrawer svc={selected} tick={tick} onClose={() => setSelected(null)} />
      )}
    </div>
  );
}

function MonRow({ svc, tick, onOpen }) {
  const [cells, setCells] = React.useState([]);
  const [loaded, setLoaded] = React.useState(false);

  React.useEffect(() => {
    fetch(`/api/monitoring/heartbeat/${svc.id}?hours=1`)
      .then(r => r.json())
      .then(d => { setCells(d.cells || []); setLoaded(true); })
      .catch(() => setLoaded(true));
  }, [svc.id]);

  const shifted = useMemo(() => {
    if (!loaded) return Array(60).fill({ status: "ok" });
    if (!cells.length) return Array(60).fill({ status: "miss" });
    const offset = tick % cells.length;
    return [...cells.slice(offset), ...cells.slice(0, offset)];
  }, [cells, loaded, tick]);

  return (
    <button className={`mon-row ${svc.status}`} onClick={onOpen} type="button">
      <div className="mon-row-svc">
        <span className={`mon-dot ${svc.status}`}></span>
        <div className="mon-row-name">
          <b>{svc.label}</b>
          <span className="mono">{_sinceLabel(svc.lastSeen)}{svc.note ? ` · ${svc.note}` : ""}</span>
        </div>
      </div>
      <div className="mon-strip">
        {shifted.map((c, i) => <span key={i} className={`hb hb-${c.status}`}></span>)}
      </div>
      <div className="mon-row-status">
        <span className={`mon-pill ${svc.status}`}>{svc.status}</span>
        <span className="mono mon-uptime">{svc.uptime}</span>
      </div>
    </button>
  );
}

// ---------- Service detail drawer (slides in on click) ----------
function ServiceDetailDrawer({ svc, tick, onClose }) {
  const isHot = svc.status === "quarantine";
  const isWarn = svc.status === "degraded";
  const tone = isHot ? "hot" : isWarn ? "warn" : "ok";
  const [realLogs, setRealLogs] = React.useState(null);
  const [heartbeatCells, setHeartbeatCells] = React.useState(null);

  React.useEffect(() => {
    fetch("/api/monitoring/errors?limit=100")
      .then((r) => r.json())
      .then((d) => {
        const all = d.errors || [];
        const filtered = all
          .filter((e) => (e.source || "").toLowerCase() === svc.id.toLowerCase())
          .slice(0, 8)
          .map((e) => ({
            lvl: e.level || "info",
            t: e["@timestamp"]
              ? new Date(e["@timestamp"]).toLocaleTimeString([], { hour12: false })
              : "--:--:--",
            msg: e.message || e.action || "",
          }));
        setRealLogs(filtered);
      })
      .catch(() => setRealLogs([]));
  }, [svc.id]);

  React.useEffect(() => {
    fetch(`/api/monitoring/heartbeat/${svc.id}?hours=1`)
      .then(r => r.json())
      .then(d => setHeartbeatCells((d.cells || []).slice(-10).reverse()))
      .catch(() => setHeartbeatCells([]));
  }, [svc.id]);

  const meta = {
    crm:        { host: "crm-prod-01.shift.be",      port: 8080, deps: ["salesforce", "identity"] },
    facturatie: { host: "facturatie-prod.shift.be",  port: 8443, deps: ["mysql", "identity"]      },
    frontend:   { host: "www.shift.be",              port: 443,  deps: ["nginx", "redis"]          },
    kassa:      { host: "kassa-prod.shift.be",       port: 8090, deps: ["odoo", "facturatie"]     },
    monitoring: { host: "monitoring-prod.shift.be",  port: 8200, deps: ["elasticsearch"]           },
    identity:   { host: "identity-prod.shift.be",    port: 8443, deps: ["postgres"]                },
  }[svc.id] || { host: "—", port: 0, deps: [] };

  const logs = realLogs !== null ? realLogs : [];

  // Lock body scroll? simple: stopPropagation
  return (
    <div className="svc-drawer-backdrop" onClick={onClose}>
      <aside className={`svc-drawer ${tone}`} onClick={(e) => e.stopPropagation()}>
        <header className="svc-drawer-head">
          <div className={`svc-drawer-ico ${svc.status}`}>{svc.label[0]}</div>
          <div className="svc-drawer-title">
            <b>{svc.label}</b>
            <span className="mono">{meta.host}:{meta.port}</span>
          </div>
          <span className={`mon-pill ${svc.status}`}>{svc.status}</span>
          <button className="svc-drawer-close" onClick={onClose} aria-label="Close">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
          </button>
        </header>

        <div className="svc-drawer-body">
          {/* Quick stats */}
          <div className="svc-stats">
            <div className="svc-stat">
              <div className="l">Uptime</div>
              <div className="v">{svc.uptime}</div>
            </div>
            <div className="svc-stat">
              <div className="l">Host</div>
              <div className="v mono" style={{ fontSize: 10 }}>{meta.host}</div>
            </div>
            <div className="svc-stat">
              <div className="l">Port</div>
              <div className="v mono">{meta.port || "—"}</div>
            </div>
            <div className="svc-stat">
              <div className="l">Last seen</div>
              <div className="v mono">{_sinceLabel(svc.lastSeen)}</div>
            </div>
          </div>

          {/* Heartbeat sparkline · last 60s — bigger version of the row strip */}
          <section className="svc-section">
            <h4>Heartbeat · last 60s</h4>
            <BigStrip svc={svc} tick={tick} />
            <div className="svc-section-foot mono">last 60 min · 1-min buckets</div>
          </section>

          {/* Last 10 heartbeats */}
          <section className="svc-section">
            <h4>Last 10 heartbeats</h4>
            <div className="svc-hb-list">
              {heartbeatCells === null && (
                <div style={{ fontSize: 11, color: "var(--muted-2)", padding: "8px 0", fontFamily: "var(--font-mono)" }}>Loading…</div>
              )}
              {heartbeatCells !== null && heartbeatCells.length === 0 && (
                <div style={{ fontSize: 11, color: "var(--muted-2)", padding: "8px 0", fontFamily: "var(--font-mono)" }}>No data.</div>
              )}
              {(heartbeatCells || []).map((hb, i) => (
                <div key={i} className={`svc-hb-row ${hb.status}`}>
                  <span className="t mono">{hb.timestamp ? new Date(hb.timestamp).toLocaleTimeString([], { hour12: false }) : "--:--:--"}</span>
                  <span className="dot"></span>
                  <span className="label">{hb.status === "ok" ? `${hb.count} beat${hb.count !== 1 ? "s" : ""}` : "missed"}</span>
                </div>
              ))}
            </div>
          </section>

          {/* Recent logs */}
          <section className="svc-section">
            <h4>Recent logs · via Monitoring MCP</h4>
            <div className="svc-logs">
              {realLogs === null && (
                <div style={{ padding: "8px 12px", fontSize: 11, color: "var(--muted-2)", fontFamily: "var(--font-mono)" }}>
                  Loading…
                </div>
              )}
              {realLogs !== null && logs.length === 0 && (
                <div style={{ padding: "8px 12px", fontSize: 11, color: "var(--muted-2)", fontFamily: "var(--font-mono)" }}>
                  No recent log entries for {svc.id}.
                </div>
              )}
              {logs.map((l, i) => (
                <div key={i} className={`svc-log ${l.lvl}`}>
                  <span className={`svc-log-lvl ${l.lvl}`}>{l.lvl}</span>
                  <span className="svc-log-t mono">{l.t}</span>
                  <span className="svc-log-msg">{l.msg}</span>
                </div>
              ))}
            </div>
          </section>

          {/* Dependencies */}
          <section className="svc-section">
            <h4>Dependencies</h4>
            <div className="svc-deps">
              {meta.deps.map((d) => (
                <span key={d} className="svc-dep mono">
                  <span className="dot online"></span>{d}
                </span>
              ))}
            </div>
          </section>

          <div className="svc-drawer-actions">
            <button className="svc-btn">View in Kibana →</button>
            <button className="svc-btn primary">Notify on-call</button>
          </div>
        </div>
      </aside>
    </div>
  );
}

function BigStrip({ svc, tick }) {
  const [cells, setCells] = React.useState([]);
  const [loaded, setLoaded] = React.useState(false);

  React.useEffect(() => {
    fetch(`/api/monitoring/heartbeat/${svc.id}?hours=1`)
      .then(r => r.json())
      .then(d => { setCells(d.cells || []); setLoaded(true); })
      .catch(() => setLoaded(true));
  }, [svc.id]);

  const shifted = useMemo(() => {
    if (!loaded) return Array(60).fill({ status: "ok" });
    if (!cells.length) return Array(60).fill({ status: "miss" });
    const offset = tick % cells.length;
    return [...cells.slice(offset), ...cells.slice(0, offset)];
  }, [cells, loaded, tick]);

  return (
    <div className="svc-big-strip">
      {shifted.map((c, i) => <span key={i} className={`hb-big hb-${c.status}`}></span>)}
    </div>
  );
}

function FlowColumn({ activeNodes, doneNodes, activeEdges, log, onClear, stats, tab, setTab }) {
  const [mcpMeta, setMcpMeta] = React.useState({ serverCount: 0, toolCount: 0 });
  const [connectedServers, setConnectedServers] = React.useState(new Set());

  React.useEffect(() => {
    fetch("/api/mcp/tools")
      .then((r) => r.json())
      .then((d) => {
        const servers = d.servers || [];
        setMcpMeta({ serverCount: servers.length, toolCount: d.total_tools || 0 });
        setConnectedServers(new Set(servers.map((s) => s.id)));
      })
      .catch(() => {});
  }, []);

  return (
    <aside className="flow-col">
      <div className="flow-head">
        <h2>MCP Topology</h2>
        <span className="sub">
          {mcpMeta.serverCount > 0
            ? `${mcpMeta.serverCount} servers · ${mcpMeta.toolCount} tools`
            : "loading…"}
        </span>
        <div className="flow-head-spacer"></div>
        <span className="live">LIVE</span>
      </div>

      <div className="flow-tabs">
        <button className={`flow-tab ${tab === "graph"   ? "is-active" : ""}`} onClick={() => setTab("graph")}>Flow graph</button>
        <button className={`flow-tab ${tab === "servers" ? "is-active" : ""}`} onClick={() => setTab("servers")}>
          Servers {mcpMeta.serverCount > 0 && <span className="count">{mcpMeta.serverCount}</span>}
        </button>
        <button className={`flow-tab ${tab === "monitoring" ? "is-active" : ""}`} onClick={() => setTab("monitoring")}>
          Monitoring
        </button>
      </div>

      {tab === "graph" && (
        <FlowTopology
          activeNodes={activeNodes}
          doneNodes={doneNodes}
          activeEdges={activeEdges}
          connectedServers={connectedServers}
        />
      )}
      {tab === "servers"    && <MCPServerList active={[...activeNodes][0]} />}
      {tab === "monitoring" && <MonitoringPanel />}

      <div className="flow-log">
        <div className="flow-log-head">
          Event log <span className="count">{log.length}</span>
          <button className="clear" onClick={onClear}>Clear</button>
        </div>
        <div className="flow-log-body">
          {log.length === 0 && (
            <div style={{ padding: "16px 18px", fontSize: 11, color: "var(--muted-2)", fontFamily: "var(--font-mono)" }}>
              — waiting for events —
            </div>
          )}
          {log.slice(-12).map((e) => (
            <div key={e.id} className={`log-row ${e.err ? "err" : ""}`} data-svc={e.svc || "audit"}>
              <span className="t">{e.time}</span>
              <span className="src">{e.src}</span>
              <span className="txt">{e.txt}</span>
              <span className="dur">{e.dur || ""}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="flow-stats">
        <div className="flow-stat">
          <div className="v">{stats.tools}</div>
          <div className="l">Tool calls</div>
        </div>
        <div className="flow-stat">
          <div className="v ok">{stats.ok}</div>
          <div className="l">OK</div>
        </div>
        <div className="flow-stat">
          <div className="v warn">{stats.warn}</div>
          <div className="l">Slow</div>
        </div>
        <div className="flow-stat">
          <div className="v">{stats.tokens}</div>
          <div className="l">Tokens</div>
        </div>
      </div>
    </aside>
  );
}

Object.assign(window, { FlowColumn });
