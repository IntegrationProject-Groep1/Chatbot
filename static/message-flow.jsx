/* eslint-disable no-undef */
/* ============================================================
   Message Flow Map — live inter-service topology from ES logs
   Polls /api/monitoring/message-flow every 10 s
   ============================================================ */
const { useEffect, useRef, useState, useCallback, useMemo } = React;

// ─── Topology layout ──────────────────────────────────────────────────────────
const SVG_W = 870, SVG_H = 510, NW = 114, NH = 40;

const FLOW_NODES = {
  "frontend":         { cx: 175, cy: 78,  label: "Frontend",   color: "#2563EB", group: "input"  },
  "kassa":            { cx: 695, cy: 78,  label: "Kassa",      color: "#C97A08", group: "input"  },
  "crm":              { cx: 435, cy: 215, label: "CRM",        color: "#7C3AED", group: "core"   },
  "identity-service": { cx: 760, cy: 215, label: "Identity",   color: "#0891B2", group: "core"   },
  "facturatie":       { cx: 175, cy: 355, label: "Facturatie", color: "#0E7C66", group: "proc"   },
  "planning":         { cx: 625, cy: 355, label: "Planning",   color: "#D97706", group: "proc"   },
  "mailing":          { cx: 400, cy: 462, label: "Mailing",    color: "#DC2626", group: "output" },
  "monitoring":       { cx: 762, cy: 440, label: "Monitoring", color: "#6366F1", group: "infra"  },
};

// Static topology: all known cross-service connections
const TOPO = [
  { from: "frontend",         to: "crm",              label: "registratie / sessie" },
  { from: "kassa",            to: "crm",              label: "registratie / wallet"  },
  { from: "crm",              to: "facturatie",        label: "betaling / factuur"    },
  { from: "crm",              to: "planning",          label: "sessie"                },
  { from: "crm",              to: "mailing",           label: "e-mail"                },
  { from: "crm",              to: "identity-service",  label: "gebruiker"             },
  { from: "facturatie",       to: "mailing",           label: "factuur / e-mail"      },
  { from: "planning",         to: "mailing",           label: "agenda"                },
  { from: "identity-service", to: "crm",              label: "gebruiker (respons)"    },
];

// Horizontal-pair offset so bidirectional edges don't overlap
const EDGE_OFFSET = {
  "crm->identity-service": -9,
  "identity-service->crm":  9,
};

// ─── SVG helpers ──────────────────────────────────────────────────────────────
function edgePath(fromId, toId) {
  const a = FLOW_NODES[fromId], b = FLOW_NODES[toId];
  if (!a || !b) return "";
  const dx = b.cx - a.cx, dy = b.cy - a.cy;
  const off = EDGE_OFFSET[`${fromId}->${toId}`] || 0;

  if (Math.abs(dy) >= Math.abs(dx) * 0.7) {
    // Mainly vertical — bottom ↔ top
    const ay = a.cy + (dy > 0 ?  NH / 2 : -NH / 2);
    const by = b.cy + (dy > 0 ? -NH / 2 :  NH / 2);
    const c1y = ay + (by - ay) * 0.5;
    const c2y = by - (by - ay) * 0.5;
    return `M ${a.cx + off} ${ay} C ${a.cx + off} ${c1y}, ${b.cx + off} ${c2y}, ${b.cx + off} ${by}`;
  } else {
    // Mainly horizontal — side ↔ side
    const ax = a.cx + (dx > 0 ?  NW / 2 : -NW / 2);
    const bx = b.cx + (dx > 0 ? -NW / 2 :  NW / 2);
    const midX = (ax + bx) / 2;
    return `M ${ax} ${a.cy + off} C ${midX} ${a.cy + off}, ${midX} ${b.cy + off}, ${bx} ${b.cy + off}`;
  }
}

function buildEdgeIndex(edges) {
  const idx = {};
  for (const e of (edges || [])) {
    const key = `${e.source}->${e.target}`;
    if (!idx[key]) idx[key] = { count: 0, errors: 0, actions: {}, recent: [] };
    idx[key].count  += e.count;
    idx[key].errors += e.errors;
    idx[key].actions[e.action] = (idx[key].actions[e.action] || 0) + e.count;
    for (const m of (e.recent_messages || [])) {
      if (idx[key].recent.length < 5) idx[key].recent.push(m);
    }
  }
  return idx;
}

function edgeStyle(count, errors) {
  if (!count) return { w: 1, op: 0.22, dash: "5 4", particles: 0 };
  if (errors > 0)  return { w: 2.5, op: 0.9,  dash: "none", particles: 2, tint: true };
  if (count < 5)   return { w: 1.5, op: 0.72, dash: "none", particles: 1 };
  if (count < 25)  return { w: 2.5, op: 0.88, dash: "none", particles: 2 };
  return               { w: 3.5, op: 1,    dash: "none", particles: 3 };
}

function pad2(n) { return String(n).padStart(2, "0"); }
function fmtTime(iso) {
  if (!iso) return "--:--:--";
  const d = new Date(iso);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}
function fmtWindow(h) {
  if (h < 1) return `${Math.round(h * 60)}m`;
  return `${h}h`;
}

const ACTION_NL = {
  registration: "Registratie", payment: "Betaling", invoice: "Factuur",
  session: "Sessie", calendar: "Agenda", email: "E-mail", wallet: "Wallet",
  badge: "Badge scan", user: "Gebruiker", refund: "Terugbetaling",
  xml_validation: "XML validatie", system_error: "Systeemfout",
};
const LEVEL_DOT = { error: "#DC2626", warning: "#D97706", info: "#0E7C66" };

// ─── SVG flow graph ───────────────────────────────────────────────────────────
function MsgFlowGraph({ nodeHealth, edgeIdx, selected, onSelect }) {
  const getHealth = (id) => {
    const h = nodeHealth[id] || {};
    if (h.live === true)  return "online";
    if (h.live === false) return "offline";
    return "unknown";
  };

  return (
    <svg viewBox={`0 0 ${SVG_W} ${SVG_H}`} preserveAspectRatio="xMidYMid meet"
      style={{ width: "100%", height: "100%", display: "block" }}>
      <defs>
        <marker id="mf-arr-idle" viewBox="0 0 10 10" refX="9" refY="5"
          markerWidth="5" markerHeight="5" orient="auto">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="#B0B6C8" />
        </marker>
        {Object.entries(FLOW_NODES).map(([id, n]) => (
          <marker key={id} id={`mf-arr-${id}`} viewBox="0 0 10 10" refX="9" refY="5"
            markerWidth="5" markerHeight="5" orient="auto">
            <path d="M 0 0 L 10 5 L 0 10 z" fill={n.color} />
          </marker>
        ))}
        <filter id="mf-glow">
          <feGaussianBlur stdDeviation="3" result="blur" />
          <feComposite in="SourceGraphic" in2="blur" operator="over" />
        </filter>
      </defs>

      {/* Layer bracket labels */}
      {[
        { y: 46, h: 64,  label: "INPUT" },
        { y: 183, h: 64, label: "CORE"  },
        { y: 323, h: 64, label: "VERWERKING" },
        { y: 430, h: 64, label: "OUTPUT" },
      ].map(({ y, h, label }) => (
        <g key={label}>
          <rect x="3" y={y} width={SVG_W - 6} height={h} rx="10"
            fill="none" stroke="var(--line)" strokeWidth="1" strokeDasharray="4 4" opacity="0.5" />
          <rect x="14" y={y - 7} width={label.length * 7 + 14} height="14" rx="3" fill="var(--bg)" />
          <text x="20" y={y + 3} fontSize="8.5" fontWeight="700" letterSpacing="0.1em"
            fontFamily="JetBrains Mono, monospace" fill="var(--muted-2)">{label}</text>
        </g>
      ))}

      {/* Edges */}
      {TOPO.map(({ from, to }) => {
        const key   = `${from}->${to}`;
        const e     = edgeIdx[key] || {};
        const { w, op, dash, particles, tint } = edgeStyle(e.count, e.errors);
        const path  = edgePath(from, to);
        const color = tint ? "#DC2626" : (FLOW_NODES[from]?.color || "#8B93A8");
        const sel   = selected?.type === "edge" && selected.key === key;
        const pid   = `mf-ep-${from}-${to}`;

        return (
          <g key={key} onClick={() => onSelect({ type: "edge", key, from, to, data: e })}
            style={{ cursor: "pointer" }}>
            {/* Fat hit-zone */}
            <path d={path} fill="none" stroke="transparent" strokeWidth={16} />
            {/* Glow for selected */}
            {sel && <path d={path} fill="none" stroke={color} strokeWidth={w + 6} opacity={0.18} />}
            {/* Main stroke */}
            <path id={pid} d={path} fill="none"
              stroke={e.count ? color : "var(--line-3)"}
              strokeWidth={sel ? w + 1.5 : w}
              opacity={sel ? 1 : op}
              strokeDasharray={dash}
              markerEnd={e.count ? `url(#mf-arr-${from})` : "url(#mf-arr-idle)"}
            />
            {/* Animated packets */}
            {particles > 0 && Array.from({ length: particles }).map((_, i) => (
              <circle key={i} r={tint ? 3.5 : 4} fill={color} opacity="0.9">
                <animateMotion dur={`${1.6 + i * 0.55}s`} begin={`${(i / particles) * 1.6}s`}
                  repeatCount="indefinite" calcMode="linear">
                  <mpath href={`#${pid}`} />
                </animateMotion>
              </circle>
            ))}
            {/* Count badge */}
            {e.count > 0 && (() => {
              const a = FLOW_NODES[from], b = FLOW_NODES[to];
              if (!a || !b) return null;
              const bx = (a.cx + b.cx) / 2 + 6;
              const by = (a.cy + b.cy) / 2 - 7;
              const txt = e.count > 999 ? "999+" : String(e.count);
              const bw  = txt.length * 6.5 + 10;
              return (
                <g>
                  <rect x={bx - bw / 2} y={by - 9} width={bw} height={15} rx="5"
                    fill="var(--surface)" stroke={color} strokeWidth="1" opacity="0.94" />
                  <text x={bx} y={by + 2} textAnchor="middle" fontSize="9"
                    fontFamily="JetBrains Mono, monospace" fill={color} fontWeight="700">
                    {txt}
                  </text>
                </g>
              );
            })()}
          </g>
        );
      })}

      {/* Nodes */}
      {Object.entries(FLOW_NODES).map(([id, node]) => {
        const health  = getHealth(id);
        const sel     = selected?.type === "node" && selected.id === id;
        const active  = TOPO.some(({ from, to }) => {
          const k = `${from}->${to}`;
          return (from === id || to === id) && (edgeIdx[k]?.count || 0) > 0;
        });
        const hc = health === "online" ? "#10B981" : health === "offline" ? "#DC2626" : "#8B93A8";
        const nx = node.cx - NW / 2;
        const ny = node.cy - NH / 2;

        return (
          <g key={id} transform={`translate(${nx}, ${ny})`}
            onClick={() => onSelect({ type: "node", id, node })}
            style={{ cursor: "pointer" }}>
            {sel && <rect x="-5" y="-5" width={NW + 10} height={NH + 10} rx="13"
              fill={node.color} opacity="0.14" />}
            <rect x="0" y="0" width={NW} height={NH} rx="9"
              fill="var(--surface)"
              stroke={sel ? node.color : (active ? node.color : "var(--line)")}
              strokeWidth={sel ? 2 : (active ? 1.5 : 1)}
            />
            {/* Left accent bar */}
            <rect x="0" y="0" width="5" height={NH} rx="2" fill={node.color} />
            <rect x="0" y={NH / 2} width="5" height={NH / 2} fill={node.color} />
            {/* Health pulse dot */}
            {health === "online" && (
              <circle cx={NW - 12} cy={NH / 2} r="5" fill={hc} opacity="0.25">
                <animate attributeName="r" values="5;9;5" dur="2.2s" repeatCount="indefinite" />
                <animate attributeName="opacity" values="0.25;0;0.25" dur="2.2s" repeatCount="indefinite" />
              </circle>
            )}
            <circle cx={NW - 12} cy={NH / 2} r="4.5" fill={hc} />
            {/* Label */}
            <text x={NW / 2 + 2} y={NH / 2 + 5} textAnchor="middle"
              fontSize="12.5" fontWeight="600" fontFamily="Inter, sans-serif" fill="var(--ink)">
              {node.label}
            </text>
          </g>
        );
      })}

      {/* Legend */}
      <g transform={`translate(6, ${SVG_H - 74})`}>
        <rect width="158" height="68" rx="7"
          fill="var(--surface)" stroke="var(--line)" strokeWidth="1" opacity="0.95" />
        <text x="10" y="16" fontSize="8" fontWeight="700" letterSpacing="0.1em"
          fontFamily="JetBrains Mono, monospace" fill="var(--muted-2)">LEGENDA</text>
        {[
          { y: 30, color: "#7C3AED", label: "Actieve berichten", w: 2 },
          { y: 44, color: "#DC2626", label: "Foutberichten",     w: 2.5 },
          { y: 58, color: "#B0B6C8", label: "Geen berichten",    dash: "5 3", w: 1 },
        ].map(({ y, color, label, dash, w }) => (
          <g key={label}>
            <line x1="10" y1={y} x2="34" y2={y}
              stroke={color} strokeWidth={w} strokeDasharray={dash || "none"} />
            <circle cx="24" cy={y} r="3.5" fill={color} opacity={dash ? 0.5 : 0.9} />
            <text x="42" y={y + 4} fontSize="9.5" fontFamily="Inter, sans-serif" fill="var(--muted)">{label}</text>
          </g>
        ))}
      </g>
    </svg>
  );
}

// ─── Selected detail panel ────────────────────────────────────────────────────
function MsgFlowDetail({ selected, edgeIdx }) {
  if (!selected) return (
    <div className="mf-detail-empty">
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--muted-3)" strokeWidth="1.5">
        <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
      </svg>
      <p>Klik op een service of verbinding voor details</p>
    </div>
  );

  if (selected.type === "node") {
    const { id, node } = selected;
    const outgoing = TOPO.filter(t => t.from === id).map(t => ({
      ...t, data: edgeIdx[`${t.from}->${t.to}`] || {},
    }));
    const incoming = TOPO.filter(t => t.to === id).map(t => ({
      ...t, data: edgeIdx[`${t.from}->${t.to}`] || {},
    }));
    const totalOut = outgoing.reduce((s, e) => s + (e.data.count || 0), 0);
    const totalIn  = incoming.reduce((s, e) => s + (e.data.count || 0), 0);

    return (
      <div className="mf-detail">
        <div className="mf-detail-title">
          <span className="mf-node-dot" style={{ background: node.color }}></span>
          {node.label}
        </div>
        <div className="mf-detail-row">
          <span className="mf-detail-key">Berichten in</span>
          <span className="mf-detail-val mono">{totalIn}</span>
        </div>
        <div className="mf-detail-row">
          <span className="mf-detail-key">Berichten uit</span>
          <span className="mf-detail-val mono">{totalOut}</span>
        </div>
        {outgoing.length > 0 && <>
          <div className="mf-detail-section">Uitgaande verbindingen</div>
          {outgoing.map(e => (
            <div key={e.to} className="mf-detail-edge">
              <span className="mf-detail-arrow">→</span>
              <span style={{ color: FLOW_NODES[e.to]?.color }}>{FLOW_NODES[e.to]?.label || e.to}</span>
              <span className="mf-detail-cnt">{e.data.count || 0}</span>
            </div>
          ))}
        </>}
        {incoming.length > 0 && <>
          <div className="mf-detail-section">Inkomende verbindingen</div>
          {incoming.map(e => (
            <div key={e.from} className="mf-detail-edge">
              <span style={{ color: FLOW_NODES[e.from]?.color }}>{FLOW_NODES[e.from]?.label || e.from}</span>
              <span className="mf-detail-arrow">→</span>
              <span>deze service</span>
              <span className="mf-detail-cnt">{e.data.count || 0}</span>
            </div>
          ))}
        </>}
      </div>
    );
  }

  if (selected.type === "edge") {
    const { from, to, data } = selected;
    const fNode = FLOW_NODES[from], tNode = FLOW_NODES[to];
    const actions = Object.entries(data.actions || {}).sort((a, b) => b[1] - a[1]);

    return (
      <div className="mf-detail">
        <div className="mf-detail-title">
          <span style={{ color: fNode?.color }}>{fNode?.label || from}</span>
          <span className="mf-detail-arrow"> → </span>
          <span style={{ color: tNode?.color }}>{tNode?.label || to}</span>
        </div>
        <div className="mf-detail-row">
          <span className="mf-detail-key">Berichten</span>
          <span className="mf-detail-val mono">{data.count || 0}</span>
        </div>
        {(data.errors || 0) > 0 && (
          <div className="mf-detail-row hot">
            <span className="mf-detail-key">Fouten</span>
            <span className="mf-detail-val mono">{data.errors}</span>
          </div>
        )}
        {actions.length > 0 && <>
          <div className="mf-detail-section">Per berichttype</div>
          {actions.map(([action, cnt]) => (
            <div key={action} className="mf-detail-edge">
              <span className="mf-action-tag">{ACTION_NL[action] || action}</span>
              <span className="mf-detail-cnt">{cnt}</span>
            </div>
          ))}
        </>}
        {(data.recent || []).length > 0 && <>
          <div className="mf-detail-section">Recente berichten</div>
          {(data.recent || []).map((m, i) => (
            <div key={i} className="mf-detail-msg">
              <span className="mf-detail-ts">{fmtTime(m.timestamp)}</span>
              <span className="mf-detail-dot" style={{ background: LEVEL_DOT[m.level] || "#8B93A8" }}></span>
              <span className="mf-detail-text">{m.message}</span>
            </div>
          ))}
        </>}
      </div>
    );
  }

  return null;
}

// ─── Live event feed ──────────────────────────────────────────────────────────
function MsgFlowFeed({ events, actionFilter, setActionFilter }) {
  const feedRef = useRef(null);

  const filtered = useMemo(() => {
    if (!events?.length) return [];
    if (!actionFilter) return events.slice(0, 80);
    return events.filter(e => e.action === actionFilter).slice(0, 80);
  }, [events, actionFilter]);

  const actions = useMemo(() => {
    if (!events?.length) return [];
    const cnt = {};
    events.forEach(e => { cnt[e.action] = (cnt[e.action] || 0) + 1; });
    return Object.entries(cnt).sort((a, b) => b[1] - a[1]).slice(0, 8);
  }, [events]);

  return (
    <div className="mf-feed">
      <div className="mf-feed-head">Live berichten</div>
      {actions.length > 0 && (
        <div className="mf-feed-filters">
          <button className={`mf-filter-btn ${!actionFilter ? "active" : ""}`}
            onClick={() => setActionFilter(null)}>Alles</button>
          {actions.map(([a, c]) => (
            <button key={a} className={`mf-filter-btn ${actionFilter === a ? "active" : ""}`}
              onClick={() => setActionFilter(actionFilter === a ? null : a)}>
              {ACTION_NL[a] || a} <span className="mf-filter-cnt">{c}</span>
            </button>
          ))}
        </div>
      )}
      <div className="mf-feed-list" ref={feedRef}>
        {filtered.length === 0 && (
          <div className="mf-feed-empty">Geen berichten in dit tijdvenster</div>
        )}
        {filtered.map((ev, i) => {
          const srcNode = FLOW_NODES[ev.source];
          return (
            <div key={i} className={`mf-feed-item lvl-${ev.level}`}>
              <span className="mf-feed-ts">{fmtTime(ev.timestamp)}</span>
              <span className="mf-feed-src" style={{ color: srcNode?.color || "var(--muted)" }}>
                {srcNode?.label || ev.source}
              </span>
              {ev.destinations?.length > 0 && (
                <span className="mf-feed-dsts">
                  →{ev.destinations.map(d => FLOW_NODES[d]?.label || d).join(", ")}
                </span>
              )}
              <span className="mf-feed-action">{ACTION_NL[ev.action] || ev.action}</span>
              {ev.message && <span className="mf-feed-msg">{ev.message.slice(0, 90)}</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Main screen ──────────────────────────────────────────────────────────────
function MessageFlowScreen() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [hours, setHours] = useState(1);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [selected, setSelected] = useState(null);
  const [lastUpdate, setLastUpdate] = useState(null);
  const [actionFilter, setActionFilter] = useState(null);

  const fetchData = useCallback(() => {
    fetch(`/api/monitoring/message-flow?hours=${hours}&limit=800`)
      .then(r => r.json())
      .then(d => {
        setData(d);
        setLastUpdate(new Date());
        setError(null);
        setLoading(false);
      })
      .catch(e => { setError(e.message); setLoading(false); });
  }, [hours]);

  useEffect(() => {
    setLoading(true);
    fetchData();
  }, [fetchData]);

  useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(fetchData, 10_000);
    return () => clearInterval(id);
  }, [autoRefresh, fetchData]);

  const edgeIdx    = useMemo(() => buildEdgeIndex(data?.edges),   [data?.edges]);
  const nodeHealth = useMemo(() => {
    const h = {};
    for (const n of (data?.nodes || [])) h[n.id] = n;
    return h;
  }, [data?.nodes]);

  const stats = data?.stats || {};
  const services = data?.nodes || [];

  const handleSelect = useCallback((item) => {
    setSelected(prev => {
      if (!prev) return item;
      if (item.type === "node" && prev.type === "node" && prev.id === item.id) return null;
      if (item.type === "edge" && prev.type === "edge" && prev.key === item.key) return null;
      return item;
    });
  }, []);

  const WINDOWS = [
    { label: "5m",  h: 0.083 },
    { label: "15m", h: 0.25  },
    { label: "1h",  h: 1     },
    { label: "6h",  h: 6     },
    { label: "24h", h: 24    },
  ];

  return (
    <div className="mf-screen">
      {/* ── Header ── */}
      <div className="mf-header">
        <div className="mf-header-left">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--primary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/>
            <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>
          </svg>
          <h2>Live Berichtenflow</h2>
          <span className="mf-header-sub">Berichten tussen services — Elasticsearch logs</span>
        </div>
        <div className="mf-header-right">
          <div className="mf-window-btns">
            {WINDOWS.map(({ label, h }) => (
              <button key={label}
                className={`mf-window-btn ${hours === h ? "active" : ""}`}
                onClick={() => { setHours(h); setSelected(null); }}>
                {label}
              </button>
            ))}
          </div>
          <button className={`mf-refresh-btn ${autoRefresh ? "active" : ""}`}
            onClick={() => setAutoRefresh(v => !v)}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/>
              <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
            </svg>
            {autoRefresh ? "Live" : "Gepauzeerd"}
          </button>
          {lastUpdate && (
            <span className="mf-last-update">
              {fmtTime(lastUpdate.toISOString())}
            </span>
          )}
        </div>
      </div>

      {/* ── Body ── */}
      <div className="mf-body">

        {/* Left sidebar */}
        <div className="mf-left">
          {/* Stats */}
          <div className="mf-section-head">Statistieken</div>
          <div className="mf-stats">
            <div className="mf-stat">
              <div className="mf-stat-val">{loading ? "—" : stats.total_messages ?? 0}</div>
              <div className="mf-stat-lbl">Berichten</div>
            </div>
            <div className={`mf-stat ${stats.error_messages > 0 ? "hot" : ""}`}>
              <div className="mf-stat-val">{loading ? "—" : stats.error_messages ?? 0}</div>
              <div className="mf-stat-lbl">Fouten</div>
            </div>
            <div className="mf-stat">
              <div className="mf-stat-val">{loading ? "—" : stats.active_flows ?? 0}</div>
              <div className="mf-stat-lbl">Actieve flows</div>
            </div>
          </div>

          {/* Service health */}
          <div className="mf-section-head">Services</div>
          <div className="mf-service-list">
            {Object.entries(FLOW_NODES).map(([id, node]) => {
              const h = nodeHealth[id] || {};
              const status = h.live === true ? "online" : h.live === false ? "offline" : "unknown";
              const hc = status === "online" ? "#10B981" : status === "offline" ? "#DC2626" : "#8B93A8";
              const active = TOPO.some(({ from, to }) => {
                const k = `${from}->${to}`;
                return (from === id || to === id) && (edgeIdx[k]?.count || 0) > 0;
              });
              const isSel = selected?.type === "node" && selected.id === id;
              return (
                <button key={id} className={`mf-svc-item ${isSel ? "selected" : ""}`}
                  onClick={() => handleSelect({ type: "node", id, node })}>
                  <span className="mf-svc-dot" style={{ background: hc }}></span>
                  <span className="mf-svc-name" style={{ color: node.color }}>{node.label}</span>
                  {active && <span className="mf-svc-active-dot"></span>}
                  <span className="mf-svc-status">{status}</span>
                </button>
              );
            })}
          </div>

          {/* Detail panel */}
          <div className="mf-section-head" style={{ marginTop: 12 }}>
            {selected ? (selected.type === "node" ? "Service detail" : "Verbinding detail") : "Detail"}
          </div>
          <MsgFlowDetail selected={selected} edgeIdx={edgeIdx} />
        </div>

        {/* Center canvas */}
        <div className="mf-canvas-wrap">
          {loading && !data && (
            <div className="mf-loading">
              <span className="mf-spin"></span>
              Laden…
            </div>
          )}
          {error && (
            <div className="mf-error">
              <b>Fout</b> — {error}
            </div>
          )}
          {(!loading || data) && (
            <MsgFlowGraph
              nodeHealth={nodeHealth}
              edgeIdx={edgeIdx}
              selected={selected}
              onSelect={handleSelect}
            />
          )}
        </div>

        {/* Right live feed */}
        <MsgFlowFeed
          events={data?.recent_events}
          actionFilter={actionFilter}
          setActionFilter={setActionFilter}
        />
      </div>
    </div>
  );
}

Object.assign(window, { MessageFlowScreen });
