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

function ToolDetailModal({ tool, serverLabel, onClose }) {
  if (!tool) return null;
  const schema = tool.inputSchema || {};
  const props = schema.properties || {};
  const required = new Set(schema.required || []);
  const paramList = Object.entries(props);

  return (
    <div
      style={{
        position: "fixed", inset: 0, zIndex: 9999,
        display: "flex", alignItems: "center", justifyContent: "center",
        background: "rgba(0,0,0,.5)", backdropFilter: "blur(4px)",
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: "var(--surface)",
          border: "1px solid var(--line-2)",
          borderRadius: "var(--r-md)",
          padding: "22px 24px",
          maxWidth: 500,
          width: "calc(100vw - 40px)",
          maxHeight: "80vh",
          overflowY: "auto",
          boxShadow: "var(--shadow-lg)",
          display: "flex",
          flexDirection: "column",
          gap: 14,
        }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 10, color: "var(--muted-2)", fontFamily: "var(--font-mono)", marginBottom: 5, textTransform: "uppercase", letterSpacing: ".06em", fontWeight: 600 }}>
              {serverLabel} · MCP
            </div>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 14, fontWeight: 700, color: "var(--ink)", wordBreak: "break-all", lineHeight: 1.3 }}>
              {tool.name}
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              background: "var(--surface-3)", border: "1px solid var(--line)", cursor: "pointer",
              color: "var(--muted)", fontSize: 14, lineHeight: 1,
              flexShrink: 0, padding: "5px 8px", borderRadius: "var(--r-sm)",
              transition: "background .12s, color .12s",
            }}
            onMouseEnter={e => { e.currentTarget.style.background = "var(--hot-soft)"; e.currentTarget.style.color = "var(--hot)"; }}
            onMouseLeave={e => { e.currentTarget.style.background = "var(--surface-3)"; e.currentTarget.style.color = "var(--muted)"; }}
          >✕</button>
        </div>

        {tool.description && (
          <div style={{
            fontSize: 12.5, color: "var(--muted)", lineHeight: 1.6,
            background: "var(--surface-2)", border: "1px solid var(--line)",
            borderRadius: "var(--r-sm)", padding: "10px 12px",
          }}>
            {tool.description}
          </div>
        )}

        {paramList.length > 0 && (
          <div>
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".06em", textTransform: "uppercase", color: "var(--muted-2)", marginBottom: 8 }}>
              Parameters
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {paramList.map(([pname, pdef]) => (
                <div key={pname} style={{
                  background: "var(--surface-2)",
                  borderRadius: "var(--r-sm)",
                  padding: "9px 12px",
                  border: "1px solid var(--line)",
                }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: pdef.description ? 5 : 0, flexWrap: "wrap" }}>
                    <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--ink)", fontWeight: 600 }}>{pname}</span>
                    <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--primary)", background: "var(--primary-soft)", padding: "1px 6px", borderRadius: "var(--r-xs)", fontWeight: 500 }}>
                      {pdef.type || "any"}
                    </span>
                    {required.has(pname) && (
                      <span style={{ fontSize: 10, color: "var(--hot)", fontWeight: 700, background: "var(--hot-soft)", padding: "1px 6px", borderRadius: "var(--r-xs)" }}>required</span>
                    )}
                  </div>
                  {pdef.description && (
                    <div style={{ fontSize: 11.5, color: "var(--muted)", lineHeight: 1.5 }}>{pdef.description}</div>
                  )}
                  {pdef.enum && (
                    <div style={{ marginTop: 5, display: "flex", flexWrap: "wrap", gap: 4 }}>
                      {pdef.enum.map(v => (
                        <span key={v} style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--ink-3)", background: "var(--surface-3)", border: "1px solid var(--line)", borderRadius: "var(--r-xs)", padding: "1px 6px" }}>{String(v)}</span>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {!tool.description && paramList.length === 0 && (
          <div style={{ fontSize: 12, color: "var(--muted-2)", fontStyle: "italic" }}>No description or parameters available.</div>
        )}
      </div>
    </div>
  );
}

function MCPServerList() {
  const [servers, setServers] = useState([]);
  const [liveStatus, setLiveStatus] = useState({});
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState({});
  const [lastPoll, setLastPoll] = useState(null);
  const [selectedTool, setSelectedTool] = useState(null); // { tool, serverLabel }

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
      {selectedTool && (
        <ToolDetailModal
          tool={selectedTool.tool}
          serverLabel={selectedTool.serverLabel}
          onClose={() => setSelectedTool(null)}
        />
      )}
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
                  {(s.tools || []).map((t) => {
                    const toolName = typeof t === "string" ? t : t.name;
                    const toolObj  = typeof t === "string" ? { name: t, description: "", inputSchema: {} } : t;
                    return (
                      <button
                        key={toolName}
                        className="srv-tool mono"
                        title="Click for details"
                        onClick={() => setSelectedTool({ tool: toolObj, serverLabel: s.id })}
                      >
                        {fmtTool(toolName)}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------- Infrastructure panel — heartbeats + logs dashboard ----------
const _INFRA_SYSTEMS = [
  { id: "chatbot",        label: "Chatbot",          group: "core" },
  { id: "frontend",       label: "Frontend",         group: "core" },
  { id: "kassa",          label: "Kassa",            group: "core" },
  { id: "facturatie",     label: "Facturatie",       group: "core" },
  { id: "crm",            label: "CRM",              group: "core" },
  { id: "planning",       label: "Planning",         group: "core" },
  { id: "mailing",        label: "Mailing",          group: "core" },
  { id: "identity-service", label: "Identity",       group: "core" },
  { id: "monitoring",     label: "Monitoring (ES)",  group: "core" },
  { id: "frontend-mcp",   label: "Frontend MCP",     group: "mcp"  },
  { id: "kassa-mcp",      label: "Kassa MCP",        group: "mcp"  },
  { id: "facturatie-mcp", label: "Facturatie MCP",   group: "mcp"  },
  { id: "crm-mcp",        label: "CRM MCP",          group: "mcp"  },
  { id: "monitoring-mcp", label: "Monitoring MCP",   group: "mcp"  },
];

function InfraHeartbeatRow({ sys, statusMap, mcpMap, onOpen }) {
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
  }, [sys.id, sys.group, mcpMap[sys.id.replace("-mcp", "")]?.connected]);

  const svc = statusMap[sys.id] || {};
  const mcpStatus = sys.group === "mcp" ? (mcpMap[sys.id.replace("-mcp", "")] || {}) : null;
  const live = sys.group === "mcp"
    ? !!mcpStatus?.connected || !!svc.live
    : (svc.live !== undefined ? svc.live : (cells.length > 0 && cells[cells.length - 1]?.status === "ok"));
  const status = live ? "online" : (svc.status === "no_data" ? "unknown" : "offline");
  const pill = status === "online" ? "ok" : status === "unknown" ? "warn" : "hot";
  const uptime = svc.uptime_seconds != null ? _uptimeLabel(svc.uptime_seconds) : "—";
  const lastSeen = svc.last_seen ? _secsSince(svc.last_seen) : "—";
  const detailSvc = {
    id: sys.id,
    label: sys.label,
    status: status === "offline" ? "quarantine" : status,
    uptime,
    lastSeen: typeof lastSeen === "number" ? lastSeen : null,
    note: sys.group === "mcp"
      ? `${mcpStatus?.connected ? "MCP connected" : "MCP disconnected"}${mcpStatus?.count != null ? ` · ${mcpStatus.count} tools` : ""}`
      : undefined,
  };

  return (
    <button className="infra-hb-row" type="button" onClick={() => onOpen?.(detailSvc)}>
      <div className="infra-hb-name">
        <span className={`infra-hb-dot ${pill}`}></span>
        {sys.label}
      </div>
      <div className="infra-hb-cells">
        {cells.map((c, i) => (
          <div key={i} className={`infra-hb-cell ${c.status === "ok" ? "ok" : "miss"}`}></div>
        ))}
        {cells.length === 0 && <span style={{ fontSize: 10, color: "var(--muted-2)" }}>loading…</span>}
      </div>
      <div className="infra-hb-meta mono">
        <span className={`mon-pill ${pill === "ok" ? "online" : pill === "warn" ? "degraded" : "quarantine"}`}>{status}</span>
        <span style={{ color: "var(--muted-2)" }}>{uptime}</span>
        <span style={{ color: "var(--muted-3)" }}>{lastSeen}</span>
      </div>
    </button>
  );
}

function InfraHeartbeats({ onOpenService }) {
  const [statusMap, setStatusMap] = React.useState({});
  const [mcpMap, setMcpMap] = React.useState({});

  React.useEffect(() => {
    const load = () => Promise.all([
      fetch("/api/monitoring/status").then(r => r.json()).catch(() => ({ services: [] })),
      fetch("/api/mcp/status").then(r => r.json()).catch(() => ({ servers: [] })),
    ]).then(([d, mcp]) => {
      const sm = {};
      (d.services || []).forEach(s => { sm[s.service] = s; });
      const mm = {};
      (mcp.servers || []).forEach(s => { mm[s.id] = s; });
      setStatusMap(sm);
      setMcpMap(mm);
    });
    load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, []);

  const core = _INFRA_SYSTEMS.filter(s => s.group === "core");
  const mcp  = _INFRA_SYSTEMS.filter(s => s.group === "mcp");

  const onlineCore = core.filter(s => statusMap[s.id]?.live).length;
  const onlineMcp  = mcp.filter(s => (mcpMap[s.id.replace("-mcp", "")] || {}).connected).length;

  return (
    <div className="infra-hb-wrap">
      <div className="infra-kpi-row">
        <div className="infra-kpi"><div className="v mono ok">{onlineCore}/{core.length}</div><div className="l">Core online</div></div>
        <div className="infra-kpi"><div className="v mono ok">{onlineMcp}/{mcp.length}</div><div className="l">MCP online</div></div>
        <div className="infra-kpi"><div className="v mono">{core.length + mcp.length}</div><div className="l">Total tracked</div></div>
      </div>

      <div className="infra-group-label">CORE SERVICES</div>
      <div className="infra-hb-list">
        <div className="infra-hb-head">
          <span>Service</span><span>Last 15 min (1 bar = 1 min)</span><span>Status · Uptime · Last seen</span>
        </div>
        {core.map(s => <InfraHeartbeatRow key={s.id} sys={s} statusMap={statusMap} mcpMap={mcpMap} onOpen={onOpenService} />)}
      </div>

      <div className="infra-group-label" style={{ marginTop: 14 }}>MCP SERVERS</div>
      <div className="infra-hb-list">
        <div className="infra-hb-head">
          <span>Server</span><span>Last 15 min (1 bar = 1 min)</span><span>Status · Uptime · Last seen</span>
        </div>
        {mcp.map(s => <InfraHeartbeatRow key={s.id} sys={s} statusMap={statusMap} mcpMap={mcpMap} onOpen={onOpenService} />)}
      </div>
    </div>
  );
}

const _LOG_LEVELS   = ["all", "info", "warning", "error"];
const _LOG_SERVICES = ["all", ...new Set(_INFRA_SYSTEMS.map(s => s.id))];

function InfraLogs() {
  const [logs, setLogs]             = React.useState([]);
  const [loading, setLoading]       = React.useState(true);
  const [levelFilter, setLevel]     = React.useState("all");
  const [serviceFilter, setService] = React.useState("all");

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

  const visible = logs.filter(e => {
    if (levelFilter   !== "all" && e.level   !== levelFilter)   return false;
    if (serviceFilter !== "all" && e.source  !== serviceFilter) return false;
    return true;
  });

  const _lvlClass = { error: "hot", warning: "warn", info: "ok" };

  return (
    <div className="infra-log-wrap">
      <div className="infra-log-filters">
        <label className="infra-filter-label">Level</label>
        <select className="infra-select" value={levelFilter} onChange={e => setLevel(e.target.value)}>
          {_LOG_LEVELS.map(l => <option key={l} value={l}>{l}</option>)}
        </select>
        <label className="infra-filter-label">Service</label>
        <select className="infra-select" value={serviceFilter} onChange={e => setService(e.target.value)}>
          {_LOG_SERVICES.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <span className="mono" style={{ color: "var(--muted-2)", fontSize: 10 }}>{visible.length} entries · auto-refresh 8s</span>
      </div>

      {loading && <div style={{ padding: "16px 14px", fontSize: 11, color: "var(--muted-2)", fontFamily: "var(--font-mono)" }}>Loading logs…</div>}

      <div className="infra-log-list">
        {!loading && visible.length === 0 && (
          <div style={{ padding: "16px 14px", fontSize: 11, color: "var(--muted-2)", fontFamily: "var(--font-mono)" }}>No log entries match the filter.</div>
        )}
        {visible.map((e, i) => (
          <div key={i} className="infra-log-row">
            <span className={`infra-log-lvl ${_lvlClass[e.level] || ""}`}>{(e.level || "?").toUpperCase().slice(0, 4)}</span>
            <span className="infra-log-src mono">{e.source || "—"}</span>
            <span className="infra-log-act mono">{e.action || "—"}</span>
            <span className="infra-log-msg">{e.message || "—"}</span>
            <span className="infra-log-ts mono">{e["@timestamp"] ? new Date(e["@timestamp"]).toLocaleTimeString([], { hour12: false }) : "—"}</span>
          </div>
        ))}
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
              <span className="mono">{s.connected ? `${s.count ?? "?"} tools` : "disconnected"}</span>
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

// ---------- Service Card Component — for Overview dashboard ─────────────────
function ServiceCard({ svc, metadata, onOpen }) {
  if (!svc) return null;
  const meta = metadata || {};
  const isOnline = svc.status === "online";
  const isDegraded = svc.status === "degraded";
  
  return (
    <div className={`svc-card ${svc.status}`} onClick={onOpen}>
      <div className="svc-card-header">
        <span className={`svc-card-status`}>
          {isOnline ? "●" : isDegraded ? "◐" : "○"}
        </span>
        <span className="svc-card-name">{svc.label}</span>
      </div>
      <div className="svc-card-body">
        <div className="svc-card-row">
          <span className="label">Host</span>
          <span className="value mono">{meta.host || "—"}</span>
        </div>
        <div className="svc-card-row">
          <span className="label">Port</span>
          <span className="value mono">{meta.port || "—"}</span>
        </div>
        {svc.uptime && (
          <div className="svc-card-row">
            <span className="label">Uptime</span>
            <span className="value mono">{svc.uptime}</span>
          </div>
        )}
        {svc.lastSeen != null && (
          <div className="svc-card-row">
            <span className="label">Last seen</span>
            <span className="value mono">{_sinceLabel(svc.lastSeen)}</span>
          </div>
        )}
      </div>
      {meta.deps && meta.deps.length > 0 && (
        <div className="svc-card-footer">
          <div className="svc-card-deps">
            {meta.deps.slice(0, 2).map((d, i) => (
              <span key={i} className="svc-dep mono">●{d}</span>
            ))}
            {meta.deps.length > 2 && (
              <span className="svc-dep mono">+{meta.deps.length - 2}</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- Enhanced Overview Dashboard ────────────────────────────────────
function OverviewDashboard({ services, metadata, onOpenService }) {
  const [loading, setLoading] = React.useState(false);
  
  if (!metadata || metadata.length === 0) {
    return (
      <div style={{ padding: "16px", fontSize: 12, color: "var(--muted-2)" }}>
        Loading service topology…
      </div>
    );
  }

  // Group services by status for cleaner layout
  const online = services.filter(s => s.status === "online");
  const degraded = services.filter(s => s.status === "degraded");
  const offline = services.filter(s => s.status === "quarantine" || s.status === "unknown");

  // Create lookup for metadata by service id
  const metaById = {};
  metadata.forEach(m => { metaById[m.id] = m; });

  return (
    <div className="overview-dashboard">
      {online.length > 0 && (
        <section className="overview-section">
          <h3 className="overview-section-title ok">● Online ({online.length})</h3>
          <div className="overview-grid">
            {online.map(svc => (
              <ServiceCard 
                key={svc.id} 
                svc={svc} 
                metadata={metaById[svc.id]}
                onOpen={() => onOpenService(svc)}
              />
            ))}
          </div>
        </section>
      )}
      
      {degraded.length > 0 && (
        <section className="overview-section">
          <h3 className="overview-section-title warn">◐ Degraded ({degraded.length})</h3>
          <div className="overview-grid">
            {degraded.map(svc => (
              <ServiceCard 
                key={svc.id} 
                svc={svc} 
                metadata={metaById[svc.id]}
                onOpen={() => onOpenService(svc)}
              />
            ))}
          </div>
        </section>
      )}
      
      {offline.length > 0 && (
        <section className="overview-section">
          <h3 className="overview-section-title hot">○ Offline / Unknown ({offline.length})</h3>
          <div className="overview-grid">
            {offline.map(svc => (
              <ServiceCard 
                key={svc.id} 
                svc={svc} 
                metadata={metaById[svc.id]}
                onOpen={() => onOpenService(svc)}
              />
            ))}
          </div>
        </section>
      )}
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
  const [metadata, setMetadata] = useState([]);
  const [lastRefresh, setLastRefresh] = useState(null);
  const [error, setError] = useState(null);
  const [tick, setTick] = useState(0);
  const [selected, setSelected] = useState(null);
  const [sub, setSub] = useState("overview");

  const fetchStatus = () => {
    Promise.all([
      fetch("/api/monitoring/status").then(r => r.json()),
      fetch("/api/mcp/status").then(r => r.json()).catch(() => ({ servers: [] })),
      fetch("/api/health").then(r => r.json()).catch(() => null),
      fetch("/api/services/metadata").then(r => r.json()).catch(() => ({ services: [] })),
    ])
      .then(([d, mcp, health, meta]) => {
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
        setMetadata(meta.services || []);
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
  
  // Build metadata lookup
  const metaById = {};
  metadata.forEach(m => { metaById[m.id] = m; });
  
  const normed = services.map(s => {
    const meta = metaById[s.service] || { host: "—", port: 0, deps: [] };
    return {
      id: s.service,
      label: _svcLabel[s.service] || (s.service.charAt(0).toUpperCase() + s.service.slice(1)),
      status: normalise(s),
      uptime: _uptimeLabel(s.uptime_seconds),
      lastSeen: _secsSince(s.last_seen),
      metadata: { host: meta.host, port: meta.port, deps: meta.deps },
    };
  });

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
      <div className="infra-sub-tabs mon-sub-tabs">
        <button className={`infra-sub-tab ${sub === "overview" ? "active" : ""}`} onClick={() => setSub("overview")}>Overview</button>
        <button className={`infra-sub-tab ${sub === "heartbeats" ? "active" : ""}`} onClick={() => setSub("heartbeats")}>Heartbeats</button>
      </div>
      <div className="mon-scroll">
        {sub === "overview" && (
          <>
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
            <button className={`mon-kpi`}>
              <div className="v mono">{normed.length}</div>
              <div className="l">Services</div>
            </button>
            <button className={`mon-kpi`}>
              <div className="v mono ok">{online}</div>
              <div className="l">Online</div>
            </button>
            <button className={`mon-kpi`}>
              <div className="v mono warn">{degraded}</div>
              <div className="l">Degraded</div>
            </button>
            <button className={`mon-kpi`}>
              <div className="v mono hot">{offlineAll}</div>
              <div className="l">Offline / Unknown</div>
            </button>
          </div>

          <div style={{ marginTop: "24px" }}>
            <OverviewDashboard 
              services={normed} 
              metadata={metadata}
              onOpenService={setSelected}
            />
          </div>
          </>
        )}

        {sub === "heartbeats" && <InfraHeartbeats onOpenService={setSelected} />}
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

  // Get metadata from the service (enriched in MonitoringPanel)
  // Fallback to minimal metadata if not found
  const meta = svc.metadata || { host: "—", port: 0, deps: [] };

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
            {svc.note && <span className="mono">{svc.note}</span>}
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
