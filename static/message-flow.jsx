/* eslint-disable no-undef */
/* ============================================================
   Live Berichtenflow — inter-service message topology
   Wrapped in IIFE so constants don't clash with admin-flow/admin-data globals.
   ============================================================ */
(function () {
const { useEffect, useRef, useState, useCallback, useMemo } = React;

// Error boundary — shows the actual error instead of a blank screen
class MFBoundary extends React.Component {
  constructor(p) { super(p); this.state = { err: null }; }
  static getDerivedStateFromError(err) { return { err }; }
  render() {
    if (this.state.err) return (
      <div style={{ gridRow: 2, gridColumn: "2/4", padding: 40, color: "var(--hot)", fontFamily: "monospace", fontSize: 13 }}>
        <b>Berichtenflow fout:</b> {this.state.err.message}
        <pre style={{ marginTop: 8, fontSize: 10, opacity: 0.7, whiteSpace: "pre-wrap", maxWidth: 600 }}>
          {this.state.err.stack}
        </pre>
      </div>
    );
    return this.props.children;
  }
}

// ─── Node layout (cx/cy = centre of each node) ───────────────────────────────
// Hub layout: CRM at center; inputs top; processing sides; output bottom.
const SVG_W = 940, SVG_H = 540, NW = 118, NH = 42;

const NODES = {
  "frontend":         { cx: 162, cy: 82,  label: "Frontend",   color: "#2563EB" },
  "kassa":            { cx: 778, cy: 82,  label: "Kassa",      color: "#C97A08" },
  "crm":              { cx: 470, cy: 225, label: "CRM",        color: "#7C3AED" },
  "identity-service": { cx: 820, cy: 225, label: "Identity",   color: "#0891B2" },
  "facturatie":       { cx: 182, cy: 370, label: "Facturatie", color: "#0E7C66" },
  "planning":         { cx: 658, cy: 370, label: "Planning",   color: "#D97706" },
  "mailing":          { cx: 420, cy: 480, label: "Mailing",    color: "#DC2626" },
  "monitoring":       { cx: 820, cy: 460, label: "Monitoring", color: "#6366F1" },
};

// Complete cross-service topology from XML/XSD Contract v2.3.
// Inactive flows render as animated dashes — "defined but no logs yet".
const TOPO = [
  // Frontend outgoing
  { from: "frontend",         to: "crm"              },  // registrations, users, sessions
  { from: "frontend",         to: "kassa"            },  // user_registered dual-publish, event_ended
  { from: "frontend",         to: "planning"         },  // calendar_invite, session requests
  { from: "frontend",         to: "facturatie"       },  // event_ended, payment_registered (online)
  // Kassa outgoing
  { from: "kassa",            to: "crm"              },  // payment_registered, badge, refund
  { from: "kassa",            to: "frontend"         },  // payment_status, wallet_balance_update
  // CRM outgoing
  { from: "crm",              to: "kassa"            },  // new_registration, profile_update
  { from: "crm",              to: "facturatie"       },  // invoice_request, profile_update
  { from: "crm",              to: "planning"         },  // session_registration_confirmed
  { from: "crm",              to: "mailing"          },  // send_mailing
  { from: "crm",              to: "frontend"         },  // payment_registered (back to portal)
  { from: "crm",              to: "identity-service" },  // identity_request (RPC)
  // Facturatie outgoing
  { from: "facturatie",       to: "crm"              },  // invoice_status, payment_registered
  { from: "facturatie",       to: "mailing"          },  // send_mailing
  { from: "facturatie",       to: "frontend"         },  // invoice_available
  // Planning outgoing — no DB, frontend owns all session data
  { from: "planning",         to: "frontend"         },  // calendar_invite_confirmed
  { from: "planning",         to: "mailing"          },  // email notifications
  // Identity outgoing
  { from: "identity-service", to: "crm"              },  // user_event fanout
  // Monitoring outgoing
  { from: "monitoring",       to: "mailing"          },  // system_alert
];

// Perpendicular offset (px) to separate bidirectional edge pairs visually
const EDGE_POFF = {
  "frontend->crm":              -11,  "crm->frontend":              11,
  "frontend->kassa":            -10,  "kassa->frontend":            10,
  "frontend->planning":         -11,  "planning->frontend":         11,
  "frontend->facturatie":       -10,  "facturatie->frontend":       10,
  "crm->kassa":                 -10,  "kassa->crm":                 10,
  "crm->facturatie":            -10,  "facturatie->crm":            10,
  "crm->planning":              -10,  "planning->crm":              10,
  "crm->identity-service":      -10,  "identity-service->crm":      10,
};

const ACTION_NL = {
  registration: "Registratie", payment: "Betaling",   invoice:  "Factuur",
  session:      "Sessie",      calendar: "Agenda",    email:    "E-mail",
  wallet:       "Wallet",      badge:    "Badge",     user:     "Gebruiker",
  refund:       "Terugbetaling", xml_validation: "XML-validatie",
  system_error: "Systeemfout",
};
const LEVEL_DOT   = { error: "#DC2626", warning: "#D97706", info: "#059669" };
const LEVEL_STRIP = { error: "#DC2626", warning: "#D97706", info: "var(--line)" };

// ─── Helpers ──────────────────────────────────────────────────────────────────
function pad2(n) { return String(n).padStart(2, "0"); }
function fmtTime(iso) {
  if (!iso) return "--:--:--";
  const d = new Date(iso);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}
function timeSince(iso) {
  if (!iso) return null;
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 5)   return "zojuist";
  if (s < 60)  return `${s}s geleden`;
  if (s < 3600) return `${Math.floor(s/60)}m geleden`;
  return `${Math.floor(s/3600)}u geleden`;
}
function fmtRate(r) {
  if (r == null || r === 0) return null;
  if (r < 0.1) return `${(r * 60).toFixed(1)}/u`;
  return `${r.toFixed(1)}/min`;
}
function eventKey(e) {
  return `${e.timestamp}|${e.source}|${e.action}|${(e.message || "").slice(0, 24)}`;
}
function buildEdgeIdx(edges) {
  const idx = {};
  for (const e of (edges || [])) {
    const k = `${e.source}->${e.target}`;
    if (!idx[k]) idx[k] = { count: 0, errors: 0, rate: 0, lastMsg: null, actions: {}, recent: [] };
    idx[k].count  += e.count;
    idx[k].errors += e.errors;
    idx[k].rate   += (e.rate_per_min || 0);
    idx[k].actions[e.action] = (idx[k].actions[e.action] || 0) + e.count;
    if (e.last_message && (!idx[k].lastMsg || e.last_message > idx[k].lastMsg))
      idx[k].lastMsg = e.last_message;
    for (const m of (e.recent_messages || []))
      if (idx[k].recent.length < 5) idx[k].recent.push(m);
  }
  return idx;
}

// ─── SVG edge path ────────────────────────────────────────────────────────────
// Uses perpendicular offset (pOff) to separate bidirectional pairs.
// Diagonal edges (|dy| near |dx|) use corner anchors on the nodes.
function edgePath(fromId, toId) {
  const a = NODES[fromId], b = NODES[toId];
  if (!a || !b) return "";
  const dx = b.cx - a.cx, dy = b.cy - a.cy;
  const pOff = EDGE_POFF[`${fromId}->${toId}`] || 0;
  const absDx = Math.abs(dx), absDy = Math.abs(dy);

  let ax, ay, bx, by;
  if (absDy >= absDx) {
    // Vertical-dominant: connect bottom → top (or top → bottom)
    ay = a.cy + (dy > 0 ?  NH/2 : -NH/2);
    by = b.cy + (dy > 0 ? -NH/2 :  NH/2);
    ax = a.cx + pOff; bx = b.cx + pOff;
    const c1y = ay + (by - ay) * 0.5;
    const c2y = by - (by - ay) * 0.5;
    return `M ${ax} ${ay} C ${ax} ${c1y}, ${bx} ${c2y}, ${bx} ${by}`;
  } else {
    // Horizontal-dominant: connect right → left (or left → right)
    ax = a.cx + (dx > 0 ?  NW/2 : -NW/2);
    bx = b.cx + (dx > 0 ? -NW/2 :  NW/2);
    const midX = (ax + bx) / 2;
    ay = a.cy + pOff; by = b.cy + pOff;
    return `M ${ax} ${ay} C ${midX} ${ay}, ${midX} ${by}, ${bx} ${by}`;
  }
}

// Renders the count+rate badge mid-edge (extracted from FlowGraph to avoid IIFE in JSX)
function renderEdgeBadge(e, mid, col) {
  const txt = e.count > 9999 ? "9999+" : String(e.count);
  const rate = fmtRate(e.rate);
  const bw = Math.max(28, txt.length * 7 + 12);
  return (
    <g transform={`translate(${mid.x - bw / 2}, ${mid.y - 12})`}>
      <rect x="0" y="0" width={bw} height="14" rx="5"
        fill="var(--surface)" stroke={col} strokeWidth="1" opacity="0.96" />
      <text x={bw / 2} y="10" textAnchor="middle" fontSize="9.5"
        fontFamily="JetBrains Mono, monospace" fill={col} fontWeight="700">{txt}</text>
      {rate && (
        <text x={bw / 2} y="24" textAnchor="middle" fontSize="8"
          fontFamily="JetBrains Mono, monospace" fill="var(--muted-2)">{rate}</text>
      )}
    </g>
  );
}

// ─── Edge visual props ────────────────────────────────────────────────────────
function edgeVis(count, errors) {
  if (!count) return { w: 0.9, op: 0.3, dash: "6 4", n: 0 };
  const errPct = errors / count;
  const tint   = errPct > 0.15;
  if (count < 5)   return { w: 1.8, op: 0.80, dash: "none", n: 1, tint, speed: 2.0 };
  if (count < 20)  return { w: 2.6, op: 0.88, dash: "none", n: 2, tint, speed: 1.7 };
  if (count < 60)  return { w: 3.4, op: 0.94, dash: "none", n: 3, tint, speed: 1.4 };
  return               { w: 4.2, op: 1.00, dash: "none", n: 4, tint, speed: 1.2 };
}

// ─── SVG flow graph ───────────────────────────────────────────────────────────
function FlowGraph({ nodeHealth, edgeIdx, selected, hovered, onSelect, onHover }) {
  const getStatus = id => {
    const h = nodeHealth[id] || {};
    if (h.live === true)  return "online";
    if (h.live === false) return "offline";
    return "unknown";
  };
  const isNodeActive = id =>
    TOPO.some(({ from, to }) => (from === id || to === id) && (edgeIdx[`${from}->${to}`]?.count || 0) > 0);

  return (
    <svg viewBox={`0 0 ${SVG_W} ${SVG_H}`} preserveAspectRatio="xMidYMid meet"
      style={{ width: "100%", height: "100%", display: "block" }}>
      <defs>
        <filter id="mf-glow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur in="SourceGraphic" stdDeviation="3.5" result="blur" />
          <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
        </filter>
        <filter id="mf-glow-sm" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur in="SourceGraphic" stdDeviation="1.8" result="blur" />
          <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
        </filter>
        <marker id="mf-arr-idle" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="4" markerHeight="4" orient="auto">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="#C7CDDE" />
        </marker>
        {Object.entries(NODES).map(([id, n]) => (
          <marker key={id} id={`mf-arr-${id}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto">
            <path d="M 0 0 L 10 5 L 0 10 z" fill={n.color} />
          </marker>
        ))}
      </defs>

      {/* Layer watermarks */}
      {[
        { label: "INPUT / TRIGGERS",  y: 52,  h: 62 },
        { label: "HUB",               y: 195, h: 62 },
        { label: "VERWERKING",        y: 340, h: 62 },
        { label: "OUTPUT",            y: 450, h: 62 },
      ].map(({ label, y, h }) => (
        <g key={label}>
          <rect x="4" y={y} width={SVG_W - 8} height={h} rx="10"
            fill="none" stroke="var(--line)" strokeWidth="1" strokeDasharray="3 5" opacity="0.4" />
          <rect x="16" y={y - 8} width={label.length * 7.2 + 14} height="16" rx="4" fill="var(--bg)" />
          <text x="22" y={y + 4.5} fontSize="8.5" fontWeight="700" letterSpacing="0.1em"
            fontFamily="JetBrains Mono, monospace" fill="var(--muted-3)">{label}</text>
        </g>
      ))}

      {/* ── Edges ── */}
      {TOPO.map(({ from, to }) => {
        const key  = `${from}->${to}`;
        const e    = edgeIdx[key] || {};
        const { w, op, dash, n: numP, tint, speed } = edgeVis(e.count, e.errors);
        const path = edgePath(from, to);
        const col  = tint ? "#DC2626" : (NODES[from]?.color || "#8B93A8");
        const sel  = selected?.type === "edge" && selected.key === key;
        const hov  = hovered?.type === "edge" && hovered.key === key;
        const pid  = `ep-${from}-${to}`;
        const mid  = (() => {
          const a = NODES[from], b = NODES[to];
          return { x: (a.cx + b.cx) / 2, y: (a.cy + b.cy) / 2 };
        })();

        return (
          <g key={key}
            onMouseEnter={() => onHover({ type: "edge", key, from, to, data: e })}
            onMouseLeave={() => onHover(null)}
            onClick={() => onSelect({ type: "edge", key, from, to, data: e })}
            style={{ cursor: "pointer" }}>

            {/* Wide transparent hit zone */}
            <path d={path} fill="none" stroke="transparent" strokeWidth={20} />

            {/* Selection/hover glow */}
            {(sel || hov) && <path d={path} fill="none" stroke={col} strokeWidth={w + 8} opacity={sel ? 0.2 : 0.12} />}

            {/* Main edge stroke */}
            <path id={pid} d={path} fill="none"
              stroke={e.count ? col : "var(--line-3)"}
              strokeWidth={sel ? w + 1.5 : w}
              opacity={sel ? 1 : (hov ? Math.min(1, op + 0.15) : op)}
              strokeDasharray={dash}
              markerEnd={e.count ? `url(#mf-arr-${from})` : "url(#mf-arr-idle)"}
            />

            {/* Dashed-edge crawl animation when inactive (CSS only — no SMIL child on path) */}
            {!e.count && (
              <path d={path} fill="none" stroke="var(--line-3)" strokeWidth={0.9}
                strokeDasharray="6 4" opacity={0.3} className="mf-dash-crawl" />
            )}

            {/* Animated packets on active edges */}
            {numP > 0 && Array.from({ length: numP }).map((_, i) => (
              <circle key={i} r={4.5} fill={col} opacity={0.92}
                filter={numP >= 3 ? "url(#mf-glow)" : "url(#mf-glow-sm)"}>
                <animateMotion
                  dur={`${(speed || 1.8) + i * 0.45}s`}
                  begin={`${(i / numP) * (speed || 1.8)}s`}
                  repeatCount="indefinite" calcMode="linear">
                  <mpath href={`#${pid}`} />
                </animateMotion>
              </circle>
            ))}

            {/* Count + rate badge on active edges */}
            {e.count > 0 && renderEdgeBadge(e, mid, col)}

            {/* "Geen logs" label on silent TOPO edges */}
            {!e.count && (
              <text x={mid.x} y={mid.y + 3} textAnchor="middle" fontSize="8.5"
                fontFamily="Inter, sans-serif" fill="var(--muted-3)" fontStyle="italic">
                geen logs
              </text>
            )}
          </g>
        );
      })}

      {/* ── Nodes ── */}
      {Object.entries(NODES).map(([id, node]) => {
        const status   = getStatus(id);
        const active   = isNodeActive(id);
        const sel      = selected?.type === "node" && selected.id === id;
        const hov      = hovered?.type  === "node" && hovered.id  === id;
        const isInfra  = id === "monitoring";
        const hc       = status === "online" ? "#10B981" : status === "offline" ? "#DC2626" : "#8B93A8";
        const nx       = node.cx - NW/2;
        const ny       = node.cy - NH/2;
        const nodeCol  = (!active && !isInfra) ? "#8B93A8" : node.color;

        return (
          <g key={id} transform={`translate(${nx}, ${ny})`}
            onMouseEnter={() => onHover({ type: "node", id, node })}
            onMouseLeave={() => onHover(null)}
            onClick={() => onSelect({ type: "node", id, node })}
            style={{ cursor: "pointer" }}>

            {/* Selection glow */}
            {(sel || hov) && (
              <rect x="-5" y="-5" width={NW+10} height={NH+10} rx="13"
                fill={nodeCol} opacity={sel ? 0.16 : 0.08} />
            )}

            {/* Node body */}
            <rect x="0" y="0" width={NW} height={NH} rx="9"
              fill="var(--surface)"
              stroke={sel ? nodeCol : (active ? nodeCol : (status === "offline" ? "#DC2626" : "var(--line)"))}
              strokeWidth={sel ? 2.5 : (active ? 1.5 : 1)}
            />

            {/* Color accent bar */}
            <rect x="0" y="0" width="5" height={NH} rx="2" fill={nodeCol} />

            {/* Health ring + dot */}
            {status === "online" && (
              <circle cx={NW-12} cy={NH/2} r="7" fill={hc} opacity="0.15">
                <animate attributeName="r" values="7;11;7" dur="2.5s" repeatCount="indefinite" />
                <animate attributeName="opacity" values="0.15;0;0.15" dur="2.5s" repeatCount="indefinite" />
              </circle>
            )}
            <circle cx={NW-12} cy={NH/2} r="4.5" fill={hc} />

            {/* INFRA badge for monitoring */}
            {isInfra && (
              <rect x={NW/2-14} y={NH-10} width="28" height="10" rx="3" fill={nodeCol} opacity="0.18" />
            )}
            {isInfra && (
              <text x={NW/2} y={NH-2} textAnchor="middle" fontSize="7.5"
                fontFamily="JetBrains Mono, monospace" fill={nodeCol} fontWeight="700" letterSpacing="0.06em">
                INFRA
              </text>
            )}

            {/* "Geen logs" subtext for silent services */}
            {!active && !isInfra && (
              <text x={NW/2 + 2} y={NH - 5} textAnchor="middle" fontSize="8"
                fontFamily="Inter, sans-serif" fill="var(--muted-3)">geen logs</text>
            )}

            {/* Service name */}
            <text x={NW/2 + 2}
              y={active || isInfra ? NH/2 + 5 : NH/2 + 1}
              textAnchor="middle" fontSize="12.5" fontWeight="600"
              fontFamily="Inter, sans-serif" fill={active ? "var(--ink)" : "var(--muted)"}>
              {node.label}
            </text>
          </g>
        );
      })}

      {/* Legend */}
      <g transform={`translate(6, ${SVG_H - 82})`}>
        <rect width="170" height="76" rx="8"
          fill="var(--surface)" stroke="var(--line)" strokeWidth="1" opacity="0.97" />
        <text x="10" y="16" fontSize="8" fontWeight="700" letterSpacing="0.1em"
          fontFamily="JetBrains Mono, monospace" fill="var(--muted-2)">LEGENDA</text>
        {[
          { y: 30, col: "#7C3AED", label: "Actieve flow (met berichten)", w: 2.5 },
          { y: 45, col: "#DC2626", label: "Foutberichten (>15%)",         w: 2.5 },
          { y: 60, col: "#C7CDDE", label: "Verwachte flow — geen logs",   w: 1, dash: "6 4" },
          { y: 72, col: "#10B981", dot: true, label: "Service online" },
        ].map(({ y, col, label, w, dash, dot }) => (
          <g key={label}>
            {dot
              ? <circle cx="18" cy={y} r="4" fill={col} opacity="0.9" />
              : <line x1="8" y1={y} x2="34" y2={y} stroke={col} strokeWidth={w} strokeDasharray={dash || "none"} />
            }
            {!dot && <circle cx="22" cy={y} r="3" fill={col} opacity={dash ? 0.4 : 0.9} />}
            <text x="34" y={y + 3.5} fontSize="9" fontFamily="Inter, sans-serif" fill="var(--muted)">{label}</text>
          </g>
        ))}
      </g>
    </svg>
  );
}

// ─── Hover tooltip ────────────────────────────────────────────────────────────
function HoverTooltip({ hovered, edgeIdx, nodeHealth, pos }) {
  if (!hovered || !pos) return null;

  let content;
  if (hovered.type === "edge") {
    const e   = edgeIdx[hovered.key] || {};
    const fN  = NODES[hovered.from];
    const tN  = NODES[hovered.to];
    const top = Object.entries(e.actions || {}).sort((a, b) => b[1] - a[1]).slice(0, 3);
    content = (
      <>
        <div className="mf-tt-title">
          <span style={{ color: fN?.color }}>{fN?.label || hovered.from}</span>
          <span className="mf-tt-arrow"> → </span>
          <span style={{ color: tN?.color }}>{tN?.label || hovered.to}</span>
        </div>
        {e.count
          ? <>
              <div className="mf-tt-row"><span>Berichten</span><b>{e.count}</b></div>
              {e.errors > 0 && <div className="mf-tt-row hot"><span>Fouten</span><b>{e.errors}</b></div>}
              {fmtRate(e.rate) && <div className="mf-tt-row"><span>Tempo</span><b>{fmtRate(e.rate)}</b></div>}
              {e.lastMsg && <div className="mf-tt-row"><span>Laatste</span><b>{timeSince(e.lastMsg)}</b></div>}
              {top.length > 0 && (
                <div className="mf-tt-actions">
                  {top.map(([a, c]) => (
                    <span key={a} className="mf-tt-tag">{ACTION_NL[a] || a} {c}</span>
                  ))}
                </div>
              )}
            </>
          : <div className="mf-tt-nodata">Geen logs in dit tijdvenster</div>
        }
      </>
    );
  } else if (hovered.type === "node") {
    const id     = hovered.id;
    const h      = nodeHealth[id] || {};
    const status = h.live === true ? "online" : h.live === false ? "offline" : "onbekend";
    const node   = NODES[id];
    const out    = TOPO.filter(t => t.from === id).map(t => ({ ...t, cnt: edgeIdx[`${t.from}->${t.to}`]?.count || 0 }));
    const inn    = TOPO.filter(t => t.to   === id).map(t => ({ ...t, cnt: edgeIdx[`${t.from}->${t.to}`]?.count || 0 }));
    content = (
      <>
        <div className="mf-tt-title" style={{ color: node?.color }}>{node?.label}</div>
        <div className="mf-tt-row">
          <span>Status</span>
          <b style={{ color: status === "online" ? "#10B981" : status === "offline" ? "#DC2626" : "#8B93A8" }}>
            {status}
          </b>
        </div>
        {h.uptime != null && (
          <div className="mf-tt-row"><span>Uptime</span><b>{h.uptime}s</b></div>
        )}
        {out.length > 0 && (
          <div className="mf-tt-flows">
            {out.map(t => (
              <div key={t.to} className="mf-tt-flow-row">
                <span className="mf-tt-arrow">→</span>
                <span style={{ color: NODES[t.to]?.color }}>{NODES[t.to]?.label || t.to}</span>
                <span className="mf-tt-cnt">{t.cnt || "—"}</span>
              </div>
            ))}
          </div>
        )}
        {inn.length > 0 && (
          <div className="mf-tt-flows">
            {inn.map(t => (
              <div key={t.from} className="mf-tt-flow-row">
                <span style={{ color: NODES[t.from]?.color }}>{NODES[t.from]?.label || t.from}</span>
                <span className="mf-tt-arrow">→</span>
                <span>deze</span>
                <span className="mf-tt-cnt">{t.cnt || "—"}</span>
              </div>
            ))}
          </div>
        )}
      </>
    );
  }

  const style = {
    position: "fixed",
    left: pos.x + 14,
    top:  pos.y - 10,
    zIndex: 9999,
    pointerEvents: "none",
  };
  // Flip left if near right edge
  if (pos.x > window.innerWidth - 230) {
    style.left = pos.x - 210;
  }

  return (
    <div className="mf-tooltip" style={style}>
      {content}
    </div>
  );
}

// ─── Click detail panel ────────────────────────────────────────────────────────
function DetailPanel({ selected, edgeIdx }) {
  if (!selected) return (
    <div className="mf-detail-empty">
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--muted-3)" strokeWidth="1.5">
        <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
      </svg>
      <span>Klik op een service of verbinding</span>
    </div>
  );

  if (selected.type === "node") {
    const { id, node } = selected;
    const out = TOPO.filter(t => t.from === id).map(t => ({ key: `${t.from}->${t.to}`, ...t, d: edgeIdx[`${t.from}->${t.to}`] || {} }));
    const inn = TOPO.filter(t => t.to   === id).map(t => ({ key: `${t.from}->${t.to}`, ...t, d: edgeIdx[`${t.from}->${t.to}`] || {} }));
    const totalOut = out.reduce((s, e) => s + (e.d.count || 0), 0);
    const totalIn  = inn.reduce((s, e) => s + (e.d.count || 0), 0);

    return (
      <div className="mf-detail">
        <div className="mf-detail-hdr">
          <span className="mf-detail-dot" style={{ background: node.color }}></span>
          <b style={{ color: node.color }}>{node.label}</b>
        </div>
        <div className="mf-detail-kv"><span>Berichten in</span><b>{totalIn}</b></div>
        <div className="mf-detail-kv"><span>Berichten uit</span><b>{totalOut}</b></div>
        {out.length > 0 && <div className="mf-detail-sub">Uitgaand</div>}
        {out.map(e => (
          <div key={e.to} className="mf-detail-flow">
            <span className="mf-detail-arrow">→</span>
            <span style={{ color: NODES[e.to]?.color, fontWeight: 500 }}>{NODES[e.to]?.label || e.to}</span>
            <span className={`mf-detail-cnt ${e.d.count ? "" : "zero"}`}>{e.d.count || "—"}</span>
          </div>
        ))}
        {inn.length > 0 && <div className="mf-detail-sub">Inkomend</div>}
        {inn.map(e => (
          <div key={e.from} className="mf-detail-flow">
            <span style={{ color: NODES[e.from]?.color, fontWeight: 500 }}>{NODES[e.from]?.label || e.from}</span>
            <span className="mf-detail-arrow">→</span>
            <span>hier</span>
            <span className={`mf-detail-cnt ${e.d.count ? "" : "zero"}`}>{e.d.count || "—"}</span>
          </div>
        ))}
      </div>
    );
  }

  if (selected.type === "edge") {
    const { from, to, data: e } = selected;
    const fN = NODES[from], tN = NODES[to];
    const actions = Object.entries(e.actions || {}).sort((a, b) => b[1] - a[1]);

    return (
      <div className="mf-detail">
        <div className="mf-detail-hdr" style={{ flexWrap: "wrap", gap: 4 }}>
          <span style={{ color: fN?.color, fontWeight: 600 }}>{fN?.label || from}</span>
          <span className="mf-detail-arrow"> → </span>
          <span style={{ color: tN?.color, fontWeight: 600 }}>{tN?.label || to}</span>
        </div>
        {!e.count
          ? <div className="mf-nodata-block">Geen berichten in dit venster</div>
          : <>
              <div className="mf-detail-kv"><span>Berichten</span><b>{e.count}</b></div>
              {e.errors > 0 && <div className="mf-detail-kv hot"><span>Fouten</span><b>{e.errors} ({Math.round(e.errors/e.count*100)}%)</b></div>}
              {fmtRate(e.rate) && <div className="mf-detail-kv"><span>Tempo</span><b>{fmtRate(e.rate)}</b></div>}
              {e.lastMsg && <div className="mf-detail-kv"><span>Laatste</span><b>{timeSince(e.lastMsg)}</b></div>}
              {actions.length > 0 && <>
                <div className="mf-detail-sub">Per type</div>
                {actions.map(([a, c]) => (
                  <div key={a} className="mf-detail-flow">
                    <span className="mf-detail-tag">{ACTION_NL[a] || a}</span>
                    <span className="mf-detail-cnt">{c}</span>
                  </div>
                ))}
              </>}
              {e.recent?.length > 0 && <>
                <div className="mf-detail-sub">Recente berichten</div>
                {e.recent.map((m, i) => (
                  <div key={i} className="mf-detail-msg">
                    <span className="mf-detail-ts">{fmtTime(m.timestamp)}</span>
                    <span className="mf-detail-lvl" style={{ background: LEVEL_DOT[m.level] || "#8B93A8" }}></span>
                    <span className="mf-detail-text">{m.message}</span>
                  </div>
                ))}
              </>}
            </>
        }
      </div>
    );
  }
  return null;
}

// ─── Live event feed ──────────────────────────────────────────────────────────
function LiveFeed({ events, actionFilter, setActionFilter, newCount }) {
  const [cachedEvents, setCachedEvents] = React.useState([]);
  const [loadingCached, setLoadingCached] = React.useState(false);

  // Load cached logs if no live events
  React.useEffect(() => {
    if (events.length === 0 && !loadingCached) {
      setLoadingCached(true);
      fetch('/api/logs/cached?limit=100')
        .then(r => r.json())
        .then(d => {
          const cached = (d.logs || []).map(log => ({
            source: log.source || 'unknown',
            action: log.action || 'unknown',
            message: log.message || '',
            timestamp: log.timestamp || new Date().toISOString(),
            level: log.level || 'info',
            destinations: [],
            isCached: true,
          }));
          setCachedEvents(cached.slice(0, 120));
        })
        .catch(() => setCachedEvents([]))
        .finally(() => setLoadingCached(false));
    }
  }, [events.length, loadingCached]);

  const displayEvents = events.length > 0 ? events : cachedEvents;
  const isCachedMode = events.length === 0 && cachedEvents.length > 0;

  const actions = useMemo(() => {
    const cnt = {};
    displayEvents.forEach(e => { cnt[e.action] = (cnt[e.action] || 0) + 1; });
    return Object.entries(cnt).sort((a, b) => b[1] - a[1]).slice(0, 8);
  }, [displayEvents]);

  const shown = useMemo(() => {
    if (!actionFilter) return displayEvents.slice(0, 120);
    return displayEvents.filter(e => e.action === actionFilter).slice(0, 120);
  }, [displayEvents, actionFilter]);

  return (
    <div className="mf-feed">
      <div className="mf-feed-hdr">
        <span>Live berichten</span>
        {isCachedMode && <span className="mf-feed-badge" style={{ background: 'var(--muted)', color: 'var(--surface)' }}>gecached</span>}
        {newCount > 0 && !isCachedMode && <span className="mf-feed-badge">{newCount} nieuw</span>}
      </div>
      <div className="mf-feed-filters">
        <button className={`mf-fbtn ${!actionFilter ? "on" : ""}`}
          onClick={() => setActionFilter(null)}>Alles</button>
        {actions.map(([a, c]) => (
          <button key={a} className={`mf-fbtn ${actionFilter === a ? "on" : ""}`}
            onClick={() => setActionFilter(f => f === a ? null : a)}>
            {ACTION_NL[a] || a} <span>{c}</span>
          </button>
        ))}
      </div>
      <div className="mf-feed-list">
        {shown.length === 0 && (
          <div className="mf-feed-empty">
            <div>Geen berichten in dit tijdvenster</div>
            {!loadingCached && <div style={{ fontSize: '10px', marginTop: '8px', color: 'var(--muted-2)', fontStyle: 'italic' }}>Services zijn mogelijk inactief. Logs worden automatisch om de 2 uur bijgewerkt.</div>}
          </div>
        )}
        {shown.map((ev, i) => {
          const sN  = NODES[ev.source];
          const age = !ev.isCached ? (Date.now() - new Date(ev.timestamp).getTime()) / 1000 : null;
          return (
            <div key={i} className={`mf-fi lvl-${ev.level}${age && age < 12 ? " fresh" : ""}${ev.isCached ? " cached" : ""}`}>
              <div className="mf-fi-head">
                <span className="mf-fi-ts">{fmtTime(ev.timestamp)}</span>
                {age && age < 8 && <span className="mf-fi-new">NEW</span>}
                {ev.isCached && <span className="mf-fi-new" style={{ background: 'var(--muted-2)' }}>CACHED</span>}
                <span className="mf-fi-src" style={{ color: sN?.color || "var(--muted)" }}>
                  {sN?.label || ev.source}
                </span>
                {ev.destinations?.length > 0 && (
                  <span className="mf-fi-dst">
                    → {ev.destinations.map(d => NODES[d]?.label || d).join(", ")}
                  </span>
                )}
              </div>
              <div className="mf-fi-body">
                <span className="mf-fi-action">{ACTION_NL[ev.action] || ev.action}</span>
                {ev.message && <span className="mf-fi-msg">{ev.message}</span>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Left sidebar ─────────────────────────────────────────────────────────────
function LeftPanel({ nodes, edgeIdx, selected, onSelect, hours }) {
  const nodeMap  = useMemo(() => Object.fromEntries((nodes || []).map(n => [n.id, n])), [nodes]);
  const topFlows = useMemo(() => {
    const flows = [];
    for (const { from, to } of TOPO) {
      const k = `${from}->${to}`;
      const e = edgeIdx[k];
      if (e?.count > 0) flows.push({ from, to, key: k, count: e.count, errors: e.errors, rate: e.rate });
    }
    return flows.sort((a, b) => b.count - a.count).slice(0, 6);
  }, [edgeIdx]);

  const totalMsgs   = useMemo(() => topFlows.reduce((s, f) => s + f.count, 0), [topFlows]);
  const totalErrors = useMemo(() => topFlows.reduce((s, f) => s + f.errors, 0), [topFlows]);
  const activeFlows = topFlows.length;

  return (
    <div className="mf-left">
      {/* Stats strip */}
      <div className="mf-stats-strip">
        <div className="mf-stat">
          <div className="mf-stat-v">{totalMsgs}</div>
          <div className="mf-stat-l">Berichten</div>
        </div>
        <div className={`mf-stat ${totalErrors > 0 ? "hot" : ""}`}>
          <div className="mf-stat-v">{totalErrors}</div>
          <div className="mf-stat-l">Fouten</div>
        </div>
        <div className="mf-stat">
          <div className="mf-stat-v">{activeFlows}</div>
          <div className="mf-stat-l">Flows</div>
        </div>
      </div>

      {/* Service health */}
      <div className="mf-section-lbl">Services</div>
      <div className="mf-svc-list">
        {Object.entries(NODES).map(([id, node]) => {
          const nd     = nodeMap[id] || {};
          const status = nd.live === true ? "online" : nd.live === false ? "offline" : "onbekend";
          const hc     = status === "online" ? "#10B981" : status === "offline" ? "#DC2626" : "#8B93A8";
          const active = TOPO.some(({ from, to }) => (from === id || to === id) && (edgeIdx[`${from}->${to}`]?.count || 0) > 0);
          const isSel  = selected?.type === "node" && selected.id === id;
          return (
            <button key={id} className={`mf-svc ${isSel ? "sel" : ""}`}
              onClick={() => onSelect({ type: "node", id, node })}>
              <span className="mf-svc-dot" style={{ background: hc }}></span>
              <span className="mf-svc-name" style={{ color: active ? node.color : "var(--muted)" }}>
                {node.label}
              </span>
              {active && <span className="mf-svc-pulse"></span>}
              <span className="mf-svc-status">{status}</span>
            </button>
          );
        })}
      </div>

      {/* Top flows */}
      {topFlows.length > 0 && <>
        <div className="mf-section-lbl" style={{ marginTop: 10 }}>
          Top flows — {hours < 1 ? `${Math.round(hours * 60)}m` : `${hours}h`}
        </div>
        <div className="mf-top-flows">
          {topFlows.map(f => {
            const fN = NODES[f.from], tN = NODES[f.to];
            const sel = selected?.type === "edge" && selected.key === f.key;
            return (
              <button key={f.key} className={`mf-flow-row ${sel ? "sel" : ""}`}
                onClick={() => onSelect({ type: "edge", key: f.key, from: f.from, to: f.to, data: edgeIdx[f.key] || {} })}>
                <span className="mf-flow-bar" style={{ width: `${Math.min(100, (f.count / (topFlows[0]?.count || 1)) * 100)}%`, background: fN?.color || "var(--primary)" }}></span>
                <span className="mf-flow-label">
                  <span style={{ color: fN?.color }}>{fN?.label}</span>
                  <span className="mf-detail-arrow"> → </span>
                  <span style={{ color: tN?.color }}>{tN?.label}</span>
                </span>
                <span className="mf-flow-cnt">{f.count}</span>
              </button>
            );
          })}
        </div>
      </>}

      {/* Detail */}
      <div className="mf-section-lbl" style={{ marginTop: 8 }}>
        {selected ? (selected.type === "node" ? "Service detail" : "Verbinding detail") : "Detail"}
      </div>
      <DetailPanel selected={selected} edgeIdx={edgeIdx} />
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────
function MessageFlowScreen() {
  const [data,         setData]         = useState(null);
  const [loading,      setLoading]      = useState(true);
  const [error,        setError]        = useState(null);
  const [hours,        setHours]        = useState(1);
  const [autoRefresh,  setAutoRefresh]  = useState(true);
  const [selected,     setSelected]     = useState(null);
  const [hovered,      setHovered]      = useState(null);
  const [tooltipPos,   setTooltipPos]   = useState(null);
  const [liveEvents,   setLiveEvents]   = useState([]);
  const [newCount,     setNewCount]     = useState(0);
  const [lastUpdate,   setLastUpdate]   = useState(null);
  const [actionFilter, setActionFilter] = useState(null);

  // Stable set of event keys we've already displayed — not reset on re-render
  const seenKeys   = useRef(new Set());
  const newCountTs = useRef(Date.now());

  // ── Fetch ──
  const fetchData = useCallback(() => {
    fetch(`/api/monitoring/message-flow?hours=${hours}&limit=1000`)
      .then(r => r.json())
      .then(d => {
        setData(d);
        setLastUpdate(new Date());
        setError(null);
        setLoading(false);

        // Only surface genuinely new events to the live feed
        const incoming = (d.recent_events || []).filter(e => {
          const k = eventKey(e);
          if (seenKeys.current.has(k)) return false;
          seenKeys.current.add(k);
          return true;
        });
        if (incoming.length > 0) {
          setLiveEvents(prev => [...incoming, ...prev].slice(0, 400));
          setNewCount(n => n + incoming.length);
          // Auto-clear the "new" count after 6 s
          setTimeout(() => setNewCount(0), 6000);
        }
      })
      .catch(e => { setError(e.message); setLoading(false); });
  }, [hours]);

  // Reset live feed when time window changes
  useEffect(() => {
    seenKeys.current.clear();
    setLiveEvents([]);
    setNewCount(0);
    setLoading(true);
    fetchData();
  }, [fetchData]);

  useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(fetchData, 10_000);
    return () => clearInterval(id);
  }, [autoRefresh, fetchData]);

  // Track mouse for tooltip
  const handleMouseMove = useCallback(e => {
    setTooltipPos({ x: e.clientX, y: e.clientY });
  }, []);

  // Derived state
  const edgeIdx    = useMemo(() => buildEdgeIdx(data?.edges),   [data?.edges]);
  const nodeHealth = useMemo(() => {
    const h = {};
    for (const n of (data?.nodes || [])) h[n.id] = n;
    return h;
  }, [data?.nodes]);

  const handleSelect = useCallback(item => {
    setSelected(prev => {
      if (!prev) return item;
      const same = (item.type === "node" && prev.type === "node" && prev.id === item.id)
                || (item.type === "edge" && prev.type === "edge" && prev.key === item.key);
      return same ? null : item;
    });
  }, []);

  const WINDOWS = [
    { l: "5m",  h: 0.083 },
    { l: "15m", h: 0.25  },
    { l: "1u",  h: 1     },
    { l: "6u",  h: 6     },
    { l: "24u", h: 24    },
  ];

  return (
    <div className="mf-screen" onMouseMove={handleMouseMove}>

      {/* ── Header ── */}
      <div className="mf-header">
        <div className="mf-hdr-left">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="var(--primary)" strokeWidth="2.2">
            <circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/>
            <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/>
            <line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>
          </svg>
          <h2>Live Berichtenflow</h2>
          <span className="mf-hdr-sub">Berichten tussen services · {TOPO.length} verbindingen gedefinieerd</span>
        </div>
        <div className="mf-hdr-right">
          <div className="mf-win-group">
            {WINDOWS.map(({ l, h }) => (
              <button key={l} className={`mf-win ${hours === h ? "on" : ""}`}
                onClick={() => { setHours(h); setSelected(null); }}>
                {l}
              </button>
            ))}
          </div>
          <button className={`mf-live-btn ${autoRefresh ? "on" : ""}`}
            onClick={() => setAutoRefresh(v => !v)}>
            <span className={`mf-live-dot ${autoRefresh ? "pulse" : ""}`}></span>
            {autoRefresh ? "Live" : "Gepauzeerd"}
          </button>
          {lastUpdate && (
            <span className="mf-hdr-ts">{fmtTime(lastUpdate.toISOString())}</span>
          )}
          <button className="mf-refresh-icon" onClick={fetchData} title="Nu vernieuwen">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <polyline points="23 4 23 10 17 10"/>
              <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
            </svg>
          </button>
        </div>
      </div>

      {/* ── Body ── */}
      <div className="mf-body">
        <LeftPanel nodes={data?.nodes} edgeIdx={edgeIdx} selected={selected}
          onSelect={handleSelect} hours={hours} />

        <div className="mf-canvas-wrap">
          {loading && !data && (
            <div className="mf-loading"><span className="mf-spin"></span> Laden…</div>
          )}
          {error && <div className="mf-error"><b>Fout:</b> {error}</div>}
          {(!loading || data) && (
            <FlowGraph
              nodeHealth={nodeHealth}
              edgeIdx={edgeIdx}
              selected={selected}
              hovered={hovered}
              onSelect={handleSelect}
              onHover={setHovered}
            />
          )}
        </div>

        <LiveFeed
          events={liveEvents}
          actionFilter={actionFilter}
          setActionFilter={setActionFilter}
          newCount={newCount}
        />
      </div>

      {/* ── Floating tooltip ── */}
      <HoverTooltip hovered={hovered} edgeIdx={edgeIdx} nodeHealth={nodeHealth} pos={tooltipPos} />
    </div>
  );
}

function MessageFlowScreenWithBoundary() {
  return (
    <MFBoundary>
      <MessageFlowScreen />
    </MFBoundary>
  );
}

Object.assign(window, { MessageFlowScreen: MessageFlowScreenWithBoundary });
})(); // end IIFE — keeps NODES, TOPO etc. out of global scope
