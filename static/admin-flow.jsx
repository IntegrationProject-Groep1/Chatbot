/* eslint-disable no-undef */
/* ============================================================
   MCP Topology — permanently visible flow visualizer
   ============================================================ */
const { useEffect, useMemo, useRef, useState } = React;

// MCP server node ids — used to detect "disconnected" state
const MCP_NODE_IDS = new Set(["frontend", "facturatie", "crm", "kassa", "monitoring"]);

const NODE_W = 130;
const NODE_H = 44;
// Backend node for each MCP server — included when that server is active
const _BACKEND_MAP = {
  frontend:   "drupal",
  facturatie: "facturatieDb",
  crm:        "crmDb",
  kassa:      "kassaDb",
  monitoring: "elastic",
};
// Tight default: trims the empty SVG space outside the actual node bounds
const _DEFAULT_VB = { x: 5, y: 10, w: 710, h: 424 };

function _computeTargetVB(activeNodes) {
  if (!activeNodes || activeNodes.size === 0) return _DEFAULT_VB;
  // Always show user + llama; add backends for active MCP servers
  const ids = new Set(["user", "llama", ...activeNodes]);
  for (const id of activeNodes) {
    const b = _BACKEND_MAP[id];
    if (b) ids.add(b);
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const id of ids) {
    const n = NODES[id];
    if (!n) continue;
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + NODE_W);
    maxY = Math.max(maxY, n.y + NODE_H);
  }
  const padX = 50, padY = 40;
  const rawW = maxX - minX + padX * 2;
  const rawH = maxY - minY + padY * 2;
  // Minimum viewport keeps the graph readable; maximum caps the zoom at default
  return {
    x: minX - padX,
    y: minY - padY,
    w: Math.min(Math.max(rawW, 260), FLOW_W),
    h: Math.min(Math.max(rawH, 220), FLOW_H),
  };
}

function _easeInOut(t) {
  return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
}

function FlowTopology({ activeNodes, doneNodes, activeEdges, litNodes, litEdges, connectedServers = new Set() }) {
  // Build edge data once
  const edges = useMemo(() => {
    return EDGES.map(([from, to, label]) => {
      const a = NODES[from];
      const b = NODES[to];
      const ax = a.x + NODE_W / 2;
      const bx = b.x + NODE_W / 2;
      const ay = a.y + NODE_H;
      const by = b.y;
      const dy = Math.abs(by - ay);
      const c1y = ay + dy * 0.55;
      const c2y = by - dy * 0.55;
      const path = `M ${ax} ${ay} C ${ax} ${c1y}, ${bx} ${c2y}, ${bx} ${by}`;
      return { from, to, label, path, ax, ay, bx, by };
    });
  }, []);

  // ── Animated viewBox ───────────────────────────────────────────────────────
  const vbRef = useRef({ ..._DEFAULT_VB });
  const [viewBox, setViewBox] = useState(_DEFAULT_VB);
  const animRef = useRef(null);

  useEffect(() => {
    const target = _computeTargetVB(activeNodes);
    if (animRef.current) cancelAnimationFrame(animRef.current);
    const start = performance.now();
    const DURATION = 480;
    const from = { ...vbRef.current };

    const step = (now) => {
      const t = _easeInOut(Math.min((now - start) / DURATION, 1));
      const cur = {
        x: from.x + (target.x - from.x) * t,
        y: from.y + (target.y - from.y) * t,
        w: from.w + (target.w - from.w) * t,
        h: from.h + (target.h - from.h) * t,
      };
      vbRef.current = cur;
      setViewBox({ ...cur });
      if (t < 1) animRef.current = requestAnimationFrame(step);
    };
    animRef.current = requestAnimationFrame(step);
    return () => { if (animRef.current) cancelAnimationFrame(animRef.current); };
  }, [activeNodes]);

  const vbStr = `${viewBox.x.toFixed(1)} ${viewBox.y.toFixed(1)} ${viewBox.w.toFixed(1)} ${viewBox.h.toFixed(1)}`;

  // Animate traveling dots on active edges
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (activeEdges.size === 0) return;
    let raf;
    const start = performance.now();
    const loop = (t) => {
      setTick(((t - start) % 3200) / 3200);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [activeEdges.size]);

  return (
    <div className="flow-canvas">
      <svg viewBox={vbStr} preserveAspectRatio="xMidYMid meet">
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

        {/* Group brackets for MCP servers + backends */}
        <g>
          <rect x="8" y="238" width={FLOW_W - 16} height="192"
            rx="14" ry="14"
            fill="rgba(243,244,250,0.55)"
            stroke="#E5E8F0"
            strokeDasharray="4 4" />
          <rect x="22" y="230" width="92" height="16" rx="3" fill="#F2F4FA" />
          <text x="30" y="241"
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
          const isLit = !isActive && litEdges && litEdges.has(key);
          const highlighted = isActive || isLit;
          return (
            <g key={key}>
              <path
                d={e.path}
                fill="none"
                stroke={highlighted ? "url(#edge-active)" : "#DADEEC"}
                strokeWidth={highlighted ? 2 : 1.2}
                strokeDasharray={highlighted ? "0" : "5 4"}
                markerEnd={highlighted ? "url(#arr-active)" : "url(#arr-idle)"}
                style={{ transition: "stroke 400ms, stroke-width 400ms" }}
              />
              <EdgeLabel path={e.path} label={e.label} active={highlighted} />
              {isActive && <TravelingDot path={e.path} t={tick} />}
            </g>
          );
        })}

        {/* Nodes as foreignObject so they share the SVG coordinate system */}
        {Object.entries(NODES).map(([id, n]) => {
          const active = activeNodes.has(id);
          const done = (doneNodes.has(id) || (litNodes && litNodes.has(id))) && !active;
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

function fmtTool(name) {
  return name.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}

function MCPServerList() {
  const [servers, setServers] = useState([]);
  const [liveStatus, setLiveStatus] = useState({});
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState({});
  const [lastPoll, setLastPoll] = useState(null);

  const fetchTools = () =>
    fetch("/api/mcp/tools")
      .then(r => r.json())
      .then(d => { setServers(d.servers || []); setLoading(false); })
      .catch(() => setLoading(false));

  const fetchStatus = () =>
    fetch("/api/mcp/status")
      .then(r => r.json())
      .then(d => {
        const m = {};
        (d.servers || []).forEach(s => { m[s.id] = s.connected; });
        setLiveStatus(m);
        setLastPoll(new Date());
      })
      .catch(() => {});

  useEffect(() => {
    fetchTools();
    fetchStatus();
    const poll = setInterval(fetchStatus, 5000);
    return () => clearInterval(poll);
  }, []);

  const toggle = (id) => setExpanded(e => ({ ...e, [id]: !e[id] }));

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

  const online  = servers.filter(s => liveStatus[s.id] === true).length;
  const offline = servers.filter(s => liveStatus[s.id] === false).length;

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <div className="srv-status-bar">
        <span className="srv-status-pill ok">{online} online</span>
        {offline > 0 && <span className="srv-status-pill hot">{offline} offline</span>}
        <span className="srv-status-time mono">
          {lastPoll ? lastPoll.toLocaleTimeString([], { hour12: false }) : "—"}
        </span>
        <button className="srv-status-refresh mono" onClick={() => { fetchStatus(); }}>↺</button>
      </div>
      <div style={{ flex: 1, minHeight: 0, padding: "8px 14px 12px", display: "flex", flexDirection: "column", gap: 6, overflowY: "auto" }}>
        {servers.map((s) => {
          const open = !!expanded[s.id];
          const connected = liveStatus[s.id];
          const connClass = connected === true ? "ok" : connected === false ? "hot" : "unknown";
          return (
            <div key={s.id} className="srv-card" data-svc={s.id}>
              <button className="srv-card-head" onClick={() => toggle(s.id)}>
                <div className="dot" style={{ flexShrink: 0 }}>{s.id[0].toUpperCase()}</div>
                <div className="text" style={{ flex: 1 }}>
                  <span className="name" style={{ textTransform: "capitalize" }}>{s.id}</span>
                  <span className="meta">{s.count} tool{s.count !== 1 ? "s" : ""}</span>
                </div>
                <span className={`srv-conn-dot ${connClass}`} title={connected === true ? "Connected" : connected === false ? "Unreachable" : "Unknown"} />
                <span className="srv-chevron">{open ? "▲" : "▼"}</span>
              </button>

              {open && (
                <div className="srv-tools">
                  {(s.tools || []).map((t) => (
                    <span key={t} className="srv-tool mono">{fmtTool(t)}</span>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------- Infrastructure panel — heartbeat grid + log feed ----------
const _ALL_SYSTEMS = [
  { id: "chatbot",          label: "Chatbot",         group: "core" },
  { id: "frontend",         label: "Frontend",        group: "core" },
  { id: "kassa",            label: "Kassa",           group: "core" },
  { id: "facturatie",       label: "Facturatie",      group: "core" },
  { id: "crm",              label: "CRM",             group: "core" },
  { id: "planning",         label: "Planning",        group: "core" },
  { id: "mailing",          label: "Mailing",         group: "core" },
  { id: "identity-service", label: "Identity",        group: "core" },
  { id: "monitoring",       label: "Monitoring (ES)", group: "core" },
  { id: "frontend-mcp",     label: "Frontend MCP",    group: "mcp"  },
  { id: "kassa-mcp",        label: "Kassa MCP",       group: "mcp"  },
  { id: "facturatie-mcp",   label: "Facturatie MCP",  group: "mcp"  },
  { id: "crm-mcp",          label: "CRM MCP",         group: "mcp"  },
  { id: "monitoring-mcp",   label: "Monitoring MCP",  group: "mcp"  },
];

const KIBANA = "https://kibana.desiderius.me";
const KIBANA_HB_DASH  = `${KIBANA}/app/dashboards#/view/shift-mcp-heartbeats-dashboard`;
const KIBANA_LOG_DASH = `${KIBANA}/app/dashboards#/view/shift-service-logs-dashboard`;

function HbRow({ sys, statusMap, mcpMap }) {
  const [cells, setCells] = React.useState([]);

  React.useEffect(() => {
    if (sys.group === "mcp") {
      const connected = (mcpMap[sys.id.replace("-mcp", "")] || {}).connected;
      setCells(Array(15).fill({ status: connected ? "ok" : "miss" }));
      return;
    }
    fetch(`/api/monitoring/heartbeat/${sys.id}?hours=1`)
      .then(r => r.json())
      .then(d => setCells((d.cells || []).slice(-15)))
      .catch(() => {});
  }, [sys.id, sys.group, JSON.stringify(mcpMap)]);

  const svc    = statusMap[sys.id] || {};
  const live   = svc.live !== undefined ? svc.live : cells.slice(-1)[0]?.status === "ok";
  const st     = live ? "online" : svc.status === "no_data" ? "unknown" : "offline";
  const pill   = st === "online" ? "ok" : st === "unknown" ? "warn" : "hot";

  return (
    <div className="ifr-row">
      <span className={`ifr-dot ${pill}`}></span>
      <span className="ifr-name">{sys.label}</span>
      <span className="ifr-cells">
        {cells.map((c, i) => <span key={i} className={`ifr-cell ${c.status === "ok" ? "ok" : "miss"}`}></span>)}
      </span>
      <span className={`mon-pill ${pill === "ok" ? "online" : pill === "warn" ? "degraded" : "quarantine"}`}>{st}</span>
    </div>
  );
}

function InfraHeartbeats() {
  const [statusMap, setStatusMap] = React.useState({});
  const [mcpMap, setMcpMap]       = React.useState({});

  React.useEffect(() => {
    const load = () => Promise.all([
      fetch("/api/monitoring/status").then(r => r.json()).catch(() => ({ services: [] })),
      fetch("/api/mcp/status").then(r => r.json()).catch(() => ({ servers: [] })),
    ]).then(([d, m]) => {
      const sm = {}; (d.services || []).forEach(s => { sm[s.service] = s; });
      const mm = {}; (m.servers  || []).forEach(s => { mm[s.id] = s; });
      setStatusMap(sm); setMcpMap(mm);
    });
    load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, []);

  const core = _ALL_SYSTEMS.filter(s => s.group === "core");
  const mcp  = _ALL_SYSTEMS.filter(s => s.group === "mcp");

  return (
    <div className="ifr-hb-wrap">
      <div className="ifr-group-head">
        CORE SERVICES
        <a href={KIBANA_HB_DASH} target="_blank" rel="noopener noreferrer" className="ifr-kibana-link">Open in Kibana →</a>
      </div>
      <div className="ifr-list">
        <div className="ifr-list-head"><span></span><span>Service</span><span>Last 15 min</span><span>Status</span></div>
        {core.map(s => <HbRow key={s.id} sys={s} statusMap={statusMap} mcpMap={mcpMap} />)}
      </div>

      <div className="ifr-group-head" style={{ marginTop: 12 }}>
        MCP SERVERS
        <a href={KIBANA_HB_DASH} target="_blank" rel="noopener noreferrer" className="ifr-kibana-link">Open in Kibana →</a>
      </div>
      <div className="ifr-list">
        <div className="ifr-list-head"><span></span><span>Server</span><span>Last 15 min</span><span>Status</span></div>
        {mcp.map(s => <HbRow key={s.id} sys={s} statusMap={statusMap} mcpMap={mcpMap} />)}
      </div>
    </div>
  );
}

function InfraLogs() {
  const [logs, setLogs]       = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [lvlFilter, setLvl]   = React.useState("all");
  const [svcFilter, setSvc]   = React.useState("all");

  React.useEffect(() => {
    const load = () =>
      fetch("/api/monitoring/errors?limit=100")
        .then(r => r.json())
        .then(d => { setLogs(d.errors || []); setLoading(false); })
        .catch(() => setLoading(false));
    load();
    const t = setInterval(load, 8000);
    return () => clearInterval(t);
  }, []);

  const services = ["all", ...new Set(logs.map(e => e.source).filter(Boolean))].sort();
  const visible  = logs.filter(e =>
    (lvlFilter === "all" || e.level === lvlFilter) &&
    (svcFilter === "all" || e.source === svcFilter)
  );
  const lvlCls = { error: "hot", warning: "warn", info: "ok" };

  return (
    <div className="ifr-log-wrap">
      <div className="ifr-log-bar">
        <span className="ifr-log-label">Level</span>
        <select className="ifr-select" value={lvlFilter} onChange={e => setLvl(e.target.value)}>
          {["all","info","warning","error"].map(l => <option key={l}>{l}</option>)}
        </select>
        <span className="ifr-log-label">Service</span>
        <select className="ifr-select" value={svcFilter} onChange={e => setSvc(e.target.value)}>
          {services.map(s => <option key={s}>{s}</option>)}
        </select>
        <a href={KIBANA_LOG_DASH} target="_blank" rel="noopener noreferrer" className="ifr-kibana-link">Open in Kibana →</a>
        <span className="mono" style={{ color: "var(--muted-3)", fontSize: 10, marginLeft: "auto" }}>{visible.length} entries · 8s</span>
      </div>

      <div className="ifr-log-list">
        {loading && <div className="ifr-log-empty">Loading…</div>}
        {!loading && visible.length === 0 && <div className="ifr-log-empty">No entries match the filter.</div>}
        {visible.map((e, i) => (
          <div key={i} className="ifr-log-row">
            <span className={`ifr-lvl ${lvlCls[e.level] || ""}`}>{(e.level||"?").slice(0,4).toUpperCase()}</span>
            <span className="ifr-src mono">{e.source || "—"}</span>
            <span className="ifr-act mono">{e.action || "—"}</span>
            <span className="ifr-msg">{e.message || "—"}</span>
            <span className="ifr-ts mono">{e["@timestamp"] ? new Date(e["@timestamp"]).toLocaleTimeString([],{hour12:false}) : "—"}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function InfraPanel() {
  const [sub, setSub] = React.useState("heartbeats");
  return (
    <div className="ifr-pane">
      <div className="ifr-tabs">
        <button className={`ifr-tab ${sub === "heartbeats" ? "active" : ""}`} onClick={() => setSub("heartbeats")}>Heartbeats</button>
        <button className={`ifr-tab ${sub === "logs"       ? "active" : ""}`} onClick={() => setSub("logs")}>Logs</button>
      </div>
      <div className="ifr-scroll">
        {sub === "heartbeats" && <InfraHeartbeats />}
        {sub === "logs"       && <InfraLogs />}
      </div>
    </div>
  );
}

// ---------- MCP Servers section — connection status from /api/mcp/status ----------
function MCPServersSection() {
  const [servers, setServers] = React.useState([]);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    const load = () =>
      fetch("/api/mcp/status")
        .then(r => r.json())
        .then(d => { setServers(d.servers || []); setLoading(false); })
        .catch(() => setLoading(false));
    load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, []);

  if (loading && servers.length === 0) return null;

  const _MCP_LABELS = { frontend: "Frontend", facturatie: "Facturatie", crm: "CRM", kassa: "Kassa", monitoring: "Monitoring" };

  return (
    <div className="mcp-svc-section">
      <div className="mcp-svc-head">MCP SERVERS</div>
      <div className="mcp-svc-grid">
        {servers.map(s => (
          <div key={s.id} className={`mcp-svc-card ${s.connected ? "ok" : "off"}`}>
            <div className="mcp-svc-dot"></div>
            <div className="mcp-svc-info">
              <b>{_MCP_LABELS[s.id] || s.id}</b>
              <span className="mono">{s.connected ? `${s.tool_count ?? "?"} tools` : "disconnected"}</span>
            </div>
            <span className={`mon-pill ${s.connected ? "online" : "quarantine"}`}>
              {s.connected ? "connected" : "offline"}
            </span>
          </div>
        ))}
        {servers.length === 0 && (
          <div style={{ padding: "10px 14px", fontSize: 11, color: "var(--muted-2)", fontFamily: "var(--font-mono)" }}>
            No MCP servers connected.
          </div>
        )}
      </div>
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
  const [statusFilter, setStatusFilter] = useState(null);

  const fetchStatus = () => {
    Promise.all([
      fetch("/api/monitoring/status").then(r => r.json()),
      fetch("/api/mcp/status").then(r => r.json()).catch(() => ({ servers: [] })),
      fetch("/api/health").then(r => r.json()).catch(() => null),
    ])
      .then(([d, mcp, health]) => {
        if (d.error) { setError(d.error); return; }
        const monitoringMcpConnected = (mcp.servers || []).some(
          s => s.id === "monitoring" && s.connected
        );
        // Monitoring can't classify itself via heartbeats — synthesize its
        // status from whether the chatbot can reach its MCP server.
        let svcs = (d.services || []).map(s => {
          if (s.service !== "monitoring") return s;
          if (monitoringMcpConnected) {
            return { ...s, live: true, status: "online", last_seen: new Date().toISOString() };
          }
          return { ...s, live: false, status: "quarantine" };
        });
        // Inject chatbot as a service if not already present (heartbeat tracked here, not by monitoring itself)
        if (!svcs.some(s => s.service === "chatbot")) {
          svcs = [
            {
              service: "chatbot",
              status: health ? "online" : "quarantine",
              live: !!health,
              uptime_seconds: health ? health.uptime_seconds : null,
              last_seen: health ? health.last_seen : null,
              synthetic: true,
            },
            ...svcs,
          ];
        }
        setServices(svcs);
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

  const _svcLabel = { "identity-service": "Identity", "iot_gateway": "IoT Gateway", "chatbot": "Chatbot" };
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
  const offlineAll = quarantined + unknown;

  const overallStatus = quarantined > 0 ? "hot"
                      : (degraded > 0 || unknown > 0) ? "warn"
                      : "ok";
  const summaryLabel = overallStatus === "ok"
    ? `All systems operational · ${online} online`
    : overallStatus === "warn"
      ? `${degraded ? degraded + " degraded · " : ""}${unknown ? unknown + " unknown · " : ""}${online} online`
      : `${quarantined} offline · ${degraded} degraded · ${online} online`;

  return (
    <div className="mon-pane">
      <div className="mon-scroll">
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

        <MCPServersSection />

        <div className="mon-kpis">
          <button className={`mon-kpi${statusFilter === null ? " active" : ""}`} onClick={() => setStatusFilter(null)}>
            <div className="v mono">{normed.length}</div>
            <div className="l">Services</div>
          </button>
          <button className={`mon-kpi${statusFilter === "online" ? " active" : ""}`} onClick={() => setStatusFilter(f => f === "online" ? null : "online")}>
            <div className="v mono ok">{online}</div>
            <div className="l">Online</div>
          </button>
          <button className={`mon-kpi${statusFilter === "degraded" ? " active" : ""}`} onClick={() => setStatusFilter(f => f === "degraded" ? null : "degraded")}>
            <div className="v mono warn">{degraded}</div>
            <div className="l">Degraded</div>
          </button>
          <button className={`mon-kpi${statusFilter === "offline-all" ? " active" : ""}`} onClick={() => setStatusFilter(f => f === "offline-all" ? null : "offline-all")}>
            <div className="v mono hot">{offlineAll}</div>
            <div className="l">Offline / Unknown</div>
          </button>
        </div>

        <div className="mon-list">
          <div className="mon-list-head">
            <span>Service</span>
            <span>Heartbeat · last 60s</span>
            <span style={{ textAlign: "right" }}>Status</span>
          </div>
          <div className="mon-list-body">
            {normed.length === 0 && !error && (
              <div style={{ padding: "16px 14px", fontSize: 11, color: "var(--muted-2)", fontFamily: "var(--font-mono)" }}>
                {lastRefresh ? "No heartbeats received yet." : "Loading…"}
              </div>
            )}
            {normed.filter(s => {
              if (statusFilter === null) return true;
              if (statusFilter === "offline-all") return s.status === "quarantine" || s.status === "unknown";
              return s.status === statusFilter;
            }).map((s) => (
              <MonRow key={s.id} svc={s} tick={tick} onOpen={() => setSelected(s)} />
            ))}
            {statusFilter !== null && normed.filter(s => statusFilter === "offline-all" ? (s.status === "quarantine" || s.status === "unknown") : s.status === statusFilter).length === 0 && (
              <div style={{ padding: "16px 14px", fontSize: 11, color: "var(--muted-2)", fontFamily: "var(--font-mono)" }}>
                No {statusFilter} services.
              </div>
            )}
          </div>
        </div>

        <InfraPanel />
      </div>

      <div className="mon-footer">
        <span className="mono" style={{ color: "var(--muted-2)" }}>
          source: heartbeats-* via Monitoring MCP · {normed.length} services (chatbot + monitoring: synthetic)
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
    // Monitoring can't heartbeat itself — synthesize a strip matching its
    // synthesized MCP-reachability status instead of fetching (which returns
    // an all-miss/red strip).
    if (svc.id === "monitoring") {
      const status = svc.status === "online" ? "ok" : "miss";
      setCells(Array(60).fill({ status }));
      setLoaded(true);
      return;
    }
    // Chatbot heartbeat is tracked here (not by monitoring itself).
    // Show all-ok since if this panel is visible, the chatbot API is alive.
    if (svc.id === "chatbot") {
      setCells(Array(60).fill({ status: svc.status === "online" ? "ok" : "miss" }));
      setLoaded(true);
      return;
    }
    fetch(`/api/monitoring/heartbeat/${svc.id}?hours=1`)
      .then(r => r.json())
      .then(d => { setCells(d.cells || []); setLoaded(true); })
      .catch(() => setLoaded(true));
  }, [svc.id, svc.status]);

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

// ---------- Notify on-call button ----------
function NotifyButton({ service }) {
  const [state, setState] = React.useState("idle"); // idle | sending | ok | err

  const send = () => {
    if (state === "sending") return;
    setState("sending");
    fetch("/api/monitoring/notify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ service, message: `Manual on-call alert for ${service} triggered from admin panel` }),
    })
      .then(r => r.json())
      .then(d => setState(d.ok ? "ok" : "err"))
      .catch(() => setState("err"))
      .finally(() => setTimeout(() => setState("idle"), 4000));
  };

  const label = { idle: "Notify on-call", sending: "Sending…", ok: "Alert sent ✓", err: "Failed ✗" }[state];
  const cls   = `svc-btn primary${state === "ok" ? " ok" : state === "err" ? " hot" : ""}`;
  return <button className={cls} onClick={send} disabled={state === "sending"}>{label}</button>;
}

// ---------- Service detail drawer (slides in on click) ----------
function ServiceDetailDrawer({ svc, tick, onClose }) {
  const isHot = svc.status === "quarantine";
  const isWarn = svc.status === "degraded";
  const tone = isHot ? "hot" : isWarn ? "warn" : "ok";
  const [realLogs, setRealLogs] = React.useState(null);
  const [heartbeatCells, setHeartbeatCells] = React.useState(null);
  const [detail, setDetail] = React.useState(null);   // from /api/monitoring/service/{id}

  const isSynthetic = svc.id === "monitoring" || svc.id === "chatbot";

  React.useEffect(() => {
    fetch("/api/monitoring/errors?limit=200")
      .then((r) => r.json())
      .then((d) => {
        const all = d.errors || [];
        const filtered = all
          .filter((e) => (e.source || "").toLowerCase() === svc.id.toLowerCase())
          .slice(0, 10)
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
    if (isSynthetic) {
      const status = svc.status === "online" ? "ok" : "miss";
      const now = new Date();
      setHeartbeatCells(Array.from({ length: 10 }, (_, i) => ({
        status,
        count: status === "ok" ? 60 : 0,
        timestamp: new Date(now - i * 60000).toISOString(),
      })));
      return;
    }
    fetch(`/api/monitoring/heartbeat/${svc.id}?hours=1`)
      .then(r => r.json())
      .then(d => setHeartbeatCells((d.cells || []).slice(-10).reverse()))
      .catch(() => setHeartbeatCells([]));
  }, [svc.id, svc.status]);

  React.useEffect(() => {
    if (isSynthetic) return;
    fetch(`/api/monitoring/service/${svc.id}`)
      .then(r => r.json())
      .then(d => setDetail(d))
      .catch(() => {});
  }, [svc.id]);

  const meta = {
    chatbot:    { host: "chatbot.shift.be",          port: 8000, deps: ["nvidia-api", "rabbitmq", "mcp-servers"] },
    crm:        { host: "crm-prod-01.shift.be",      port: 8080, deps: ["salesforce", "identity"] },
    facturatie: { host: "facturatie-prod.shift.be",  port: 8443, deps: ["mysql", "identity"]      },
    frontend:   { host: "www.shift.be",              port: 443,  deps: ["nginx", "redis"]          },
    kassa:      { host: "kassa-prod.shift.be",       port: 8090, deps: ["odoo", "facturatie"]     },
    mailing:    { host: "mailing.shift.be",          port: 8080, deps: ["rabbitmq", "sendgrid"]   },
    monitoring: { host: "monitoring-prod.shift.be",  port: 8200, deps: ["elasticsearch"]           },
    identity:   { host: "identity-prod.shift.be",    port: 8443, deps: ["postgres"]                },
  }[svc.id] || { host: "—", port: 0, deps: [] };

  const uptimeHuman = detail?.uptime_human || svc.uptime;
  const avail       = detail?.availability_24h;
  const healthScore = detail?.health_score;
  const errDensity  = detail?.error_density;
  const hb24h       = detail?.heartbeats_24h;

  const _scoreColor = (s) => s >= 8 ? "ok" : s >= 5 ? "warn" : "hot";
  const _availColor = (a) => a >= 99 ? "ok" : a >= 90 ? "warn" : "hot";

  const logs = realLogs !== null ? realLogs : [];

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
          {/* Quick stats — real data from /api/monitoring/service/{id} */}
          <div className="svc-stats">
            <div className="svc-stat">
              <div className="l">Uptime</div>
              <div className="v mono">{uptimeHuman || "—"}</div>
            </div>
            <div className="svc-stat">
              <div className="l">Availability 24h</div>
              <div className={`v mono ${avail != null ? _availColor(avail) : ""}`}>
                {avail != null ? `${avail.toFixed(1)}%` : isSynthetic ? "n/a" : "…"}
              </div>
            </div>
            <div className="svc-stat">
              <div className="l">Health score</div>
              <div className={`v mono ${healthScore != null ? _scoreColor(healthScore) : ""}`}>
                {healthScore != null ? `${healthScore}/10` : isSynthetic ? "n/a" : "…"}
              </div>
            </div>
            <div className="svc-stat">
              <div className="l">Last seen</div>
              <div className="v mono">{_sinceLabel(svc.lastSeen)}</div>
            </div>
          </div>

          {/* Error density + heartbeats if available */}
          {detail && (errDensity != null || hb24h != null) && (
            <div className="svc-stats" style={{ marginTop: 0 }}>
              {hb24h != null && (
                <div className="svc-stat">
                  <div className="l">Heartbeats 24h</div>
                  <div className="v mono">{hb24h.toLocaleString()}</div>
                </div>
              )}
              {errDensity != null && (
                <div className="svc-stat">
                  <div className={`l ${errDensity > 50 ? "hot" : ""}`}>Error density</div>
                  <div className={`v mono ${errDensity > 50 ? "hot" : errDensity > 10 ? "warn" : "ok"}`}>
                    {errDensity.toFixed(1)}‰
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Heartbeat sparkline · last 60 min */}
          <section className="svc-section">
            <h4>Heartbeat · last 60 min</h4>
            <BigStrip svc={svc} tick={tick} />
            <div className="svc-section-foot mono">1-min buckets{isSynthetic ? " · synthesized" : " · from Elasticsearch"}</div>
          </section>

          {/* Last 10 heartbeat buckets */}
          <section className="svc-section">
            <h4>Last 10 min — heartbeat buckets</h4>
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
            <a
              className="svc-btn"
              href={`https://kibana.desiderius.me/app/dashboards#/view/shift-mcp-heartbeats-dashboard?_g=(filters:!(),refreshInterval:(pause:!f,value:10000),time:(from:now-1h,to:now))&_a=(query:(language:kuery,query:'system.keyword:%22${encodeURIComponent(svc.id)}%22'))`}
              target="_blank"
              rel="noopener noreferrer"
            >View in Kibana →</a>
            <NotifyButton service={svc.id} />
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
    if (svc.id === "monitoring" || svc.id === "chatbot") {
      const status = svc.status === "online" ? "ok" : "miss";
      setCells(Array(60).fill({ status }));
      setLoaded(true);
      return;
    }
    fetch(`/api/monitoring/heartbeat/${svc.id}?hours=1`)
      .then(r => r.json())
      .then(d => { setCells(d.cells || []); setLoaded(true); })
      .catch(() => setLoaded(true));
  }, [svc.id, svc.status]);

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

function FlowColumn({ activeNodes, doneNodes, activeEdges, litNodes, litEdges, log, onClear, stats, tab, setTab }) {
  const [mcpMeta, setMcpMeta] = React.useState({ serverCount: 0, toolCount: 0 });
  const [connectedServers, setConnectedServers] = React.useState(new Set());
  const logBodyRef = React.useRef(null);

  React.useEffect(() => {
    const el = logBodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log]);

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
          litNodes={litNodes}
          litEdges={litEdges}
          connectedServers={connectedServers}
        />
      )}
      {tab === "servers"    && <MCPServerList active={[...activeNodes][0]} />}
      {tab === "monitoring" && <MonitoringPanel />}

      {tab === "graph" && (
      <div className="flow-log">
        <div className="flow-log-head">
          Event log <span className="count">{log.length}</span>
          <button className="clear" onClick={onClear}>Clear</button>
        </div>
        <div className="flow-log-body" ref={logBodyRef}>
          {log.length === 0 && (
            <div style={{ padding: "16px 18px", fontSize: 11, color: "var(--muted-2)", fontFamily: "var(--font-mono)" }}>
              — waiting for events —
            </div>
          )}
          {log.map((e) => (
            <div key={e.id} className={`log-row ${e.err ? "err" : ""}`} data-svc={e.svc || "audit"}>
              <span className="t">{e.time}</span>
              <span className="src">{e.src}</span>
              <span className="txt">{e.txt}</span>
              <span className="dur">{e.dur && e.dur !== "—" ? e.dur : ""}</span>
            </div>
          ))}
        </div>
      </div>
      )}

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
