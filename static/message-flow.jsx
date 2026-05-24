/* eslint-disable no-undef */
/* ============================================================
   Live Berichtenflow — inter-service message topology
   Wrapped in IIFE so constants don't clash with admin-flow globals.
   ============================================================ */
(function () {
const { useEffect, useRef, useState, useCallback, useMemo } = React;

// ─── Error boundary ───────────────────────────────────────────────────────────
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

// ─── Node layout ──────────────────────────────────────────────────────────────
const SVG_W = 940, SVG_H = 540, NW = 118, NH = 42;

const NODES = {
  "frontend":         { cx: 162, cy: 82,  label: "Frontend",   color: "#2563EB", cssVar: "--svc-frontend" },
  "kassa":            { cx: 778, cy: 82,  label: "Kassa",      color: "#C97A08", cssVar: "--svc-kassa" },
  "crm":              { cx: 470, cy: 225, label: "CRM",        color: "#7C3AED", cssVar: "--svc-crm" },
  "identity-service": { cx: 820, cy: 225, label: "Identity",   color: "#0891B2", cssVar: "--svc-identity" },
  "facturatie":       { cx: 182, cy: 370, label: "Facturatie", color: "#0E7C66", cssVar: "--svc-facturatie" },
  "planning":         { cx: 658, cy: 370, label: "Planning",   color: "#D97706", cssVar: "--svc-planning" },
  "mailing":          { cx: 420, cy: 480, label: "Mailing",    color: "#DC2626", cssVar: "--svc-mailing" },
  "monitoring":       { cx: 820, cy: 460, label: "Monitoring", color: "#6366F1", cssVar: "--svc-monitoring" },
};

const TOPO = [
  { from: "frontend",         to: "crm"              },
  { from: "frontend",         to: "kassa"            },
  { from: "frontend",         to: "planning"         },
  { from: "frontend",         to: "facturatie"       },
  { from: "kassa",            to: "crm"              },
  { from: "kassa",            to: "frontend"         },
  { from: "crm",              to: "kassa"            },
  { from: "crm",              to: "facturatie"       },
  { from: "crm",              to: "planning"         },
  { from: "crm",              to: "mailing"          },
  { from: "crm",              to: "frontend"         },
  { from: "crm",              to: "identity-service" },
  { from: "facturatie",       to: "crm"              },
  { from: "facturatie",       to: "mailing"          },
  { from: "facturatie",       to: "frontend"         },
  { from: "planning",         to: "frontend"         },
  { from: "planning",         to: "mailing"          },
  { from: "identity-service", to: "crm"              },
  { from: "monitoring",       to: "mailing"          },
];

const EDGE_POFF = {
  "frontend->crm":             -11,  "crm->frontend":              11,
  "frontend->kassa":           -10,  "kassa->frontend":            10,
  "frontend->planning":        -11,  "planning->frontend":         11,
  "frontend->facturatie":      -10,  "facturatie->frontend":       10,
  "crm->kassa":                -10,  "kassa->crm":                 10,
  "crm->facturatie":           -10,  "facturatie->crm":            10,
  "crm->planning":             -10,  "planning->crm":              10,
  "crm->identity-service":     -10,  "identity-service->crm":      10,
};

const ACTION_NL = {
  registration: "Registratie", payment: "Betaling",   invoice:  "Factuur",
  session:      "Sessie",      calendar: "Agenda",    email:    "E-mail",
  wallet:       "Wallet",      badge:    "Badge",     user:     "Gebruiker",
  refund:       "Terugbetaling", xml_validation: "XML-validatie",
  system_error: "Systeemfout",
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
// Resolves a node's color as a CSS variable (theme-adaptive) with hex fallback
function nc(node) { return node?.cssVar ? `var(${node.cssVar})` : (node?.color || "var(--muted)"); }
function pad2(n) { return String(n).padStart(2, "0"); }
function fmtTime(iso) {
  if (!iso) return "--:--:--";
  const d = new Date(iso);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}
function ago(iso) {
  if (!iso) return "";
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 5)    return "zojuist";
  if (s < 60)   return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}u`;
  return `${Math.floor(s / 86400)}d`;
}
function timeSince(iso) {
  if (!iso) return null;
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 5)    return "zojuist";
  if (s < 60)   return `${s}s geleden`;
  if (s < 3600) return `${Math.floor(s / 60)}m geleden`;
  return `${Math.floor(s / 3600)}u geleden`;
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
      if (idx[k].recent.length < 12) idx[k].recent.push(m);
  }
  return idx;
}

// ─── XML highlighting ─────────────────────────────────────────────────────────
function highlightXML(raw) {
  if (!raw) return "";
  return raw
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/(&lt;\/?)([\w:-]+)/g, '$1<span class="mf-xml-tag">$2</span>')
    .replace(/([\w:-]+)=/g, '<span class="mf-xml-attr">$1</span>=')
    .replace(/=&quot;([^&]*)&quot;/g, '=&quot;<span class="mf-xml-val">$1</span>&quot;');
}

// ─── Detail log item (shared by node + edge detail panels) ───────────────────
function DetailLogItem({ m }) {
  const isXML = m.message && (m.message.includes("<") || m.message.toLowerCase().includes("xml"));
  const lvl = m.level || "info";
  const [expanded, setExpanded] = React.useState(false);
  const msg = m.message || "";
  const isLong = msg.length > 160;
  return (
    <div className={`mf-detail-log-item lvl-${lvl}`} onClick={() => isLong && setExpanded(x => !x)}
      style={{ cursor: isLong ? "pointer" : "default" }}>
      <div className="mf-detail-log-head">
        <span className="mf-detail-log-ts">{fmtTime(m.timestamp)}</span>
        <span className="mf-detail-lvl-badge" data-lvl={lvl}>{lvl}</span>
        {m.action && <span className="mf-detail-action-chip">{ACTION_NL[m.action] || m.action}</span>}
        {isLong && <span style={{ marginLeft: "auto", fontSize: 9, color: "var(--muted-3)" }}>{expanded ? "↑" : "↓"}</span>}
      </div>
      {isXML
        ? <div className="mf-detail-xml" dangerouslySetInnerHTML={{ __html: highlightXML(msg) }} />
        : <div className="mf-detail-log-msg" style={{
            whiteSpace: "pre-wrap", wordBreak: "break-word",
            display: "-webkit-box", WebkitLineClamp: expanded ? "unset" : 4,
            WebkitBoxOrient: "vertical", overflow: expanded ? "visible" : "hidden",
          }}>{msg}</div>
      }
    </div>
  );
}

// ─── SVG helpers ──────────────────────────────────────────────────────────────
function edgePath(fromId, toId, positions) {
  const a = (positions && positions[fromId]) || NODES[fromId];
  const b = (positions && positions[toId])   || NODES[toId];
  if (!a || !b) return "";
  const dx = b.cx - a.cx, dy = b.cy - a.cy;
  const pOff = EDGE_POFF[`${fromId}->${toId}`] || 0;
  const absDx = Math.abs(dx), absDy = Math.abs(dy);
  let ax, ay, bx, by;
  if (absDy >= absDx) {
    ay = a.cy + (dy > 0 ?  NH/2 : -NH/2);
    by = b.cy + (dy > 0 ? -NH/2 :  NH/2);
    ax = a.cx + pOff; bx = b.cx + pOff;
    const c1y = ay + (by - ay) * 0.45;
    const c2y = by - (by - ay) * 0.45;
    return `M ${ax} ${ay} C ${ax} ${c1y}, ${bx} ${c2y}, ${bx} ${by}`;
  }
  ax = a.cx + (dx > 0 ?  NW/2 : -NW/2);
  bx = b.cx + (dx > 0 ? -NW/2 :  NW/2);
  const midX = (ax + bx) / 2;
  ay = a.cy + pOff; by = b.cy + pOff;
  return `M ${ax} ${ay} C ${midX} ${ay}, ${midX} ${by}, ${bx} ${by}`;
}

function edgeVis(count, errors) {
  if (!count) return { w: 1, op: 0.28, dash: "5 6", tint: false };
  const errPct = errors / count;
  const tint   = errPct > 0.15;
  const sw = Math.min(3.6, 1.4 + Math.log10(count + 1) * 1.4);
  return { w: sw, op: 0.92, dash: "none", tint };
}

// ─── One-shot packet that rides an edge path ──────────────────────────────────
function Packet({ pkt, onDone }) {
  useEffect(() => {
    const tm = setTimeout(onDone, pkt.dur + (pkt.delay || 0) + 300);
    return () => clearTimeout(tm);
  }, []);
  const col = nc(NODES[pkt.from]);
  const pid = `ep-${pkt.from}-${pkt.to}`;
  const r = pkt.level === "error" ? 7 : 5.5;
  const durS   = (pkt.dur / 1000).toFixed(3) + "s";
  const delayS = ((pkt.delay || 0) / 1000).toFixed(3) + "s";
  return (
    <g style={{ pointerEvents: "none" }} filter="url(#mf-glow)">
      <circle r={r + 3} fill={col}>
        <animateMotion dur={durS} begin={delayS} fill="freeze" repeatCount="1">
          <mpath href={`#${pid}`} />
        </animateMotion>
        <animate attributeName="opacity" values="0;0.28;0.28;0"
                 keyTimes="0;0.08;0.85;1" dur={durS} begin={delayS} fill="freeze" />
      </circle>
      <circle r={r} fill="white">
        <animateMotion dur={durS} begin={delayS} fill="freeze" repeatCount="1">
          <mpath href={`#${pid}`} />
        </animateMotion>
        <animate attributeName="opacity" values="0;1;1;0"
                 keyTimes="0;0.06;0.9;1" dur={durS} begin={delayS} fill="freeze" />
      </circle>
      <circle r={r - 2} fill={col}>
        <animateMotion dur={durS} begin={delayS} fill="freeze" repeatCount="1">
          <mpath href={`#${pid}`} />
        </animateMotion>
        <animate attributeName="opacity" values="0;1;1;0"
                 keyTimes="0;0.06;0.9;1" dur={durS} begin={delayS} fill="freeze" />
      </circle>
    </g>
  );
}

// ─── Node pulse ring ──────────────────────────────────────────────────────────
function NodePulse({ pulse, nodePos, onDone }) {
  useEffect(() => {
    const tm = setTimeout(onDone, 900);
    return () => clearTimeout(tm);
  }, []);
  const node = NODES[pulse.nodeId];
  if (!node) return null;
  const pos = (nodePos && nodePos[pulse.nodeId]) || node;
  const color = pulse.level === "error" ? "var(--hot)" : nc(node);
  return (
    <circle cx={pos.cx} cy={pos.cy} r="22"
      fill="none" stroke={color} strokeWidth="2"
      style={{ pointerEvents: "none" }}>
      <animate attributeName="r"       values="22;64"  dur="0.85s" fill="freeze" />
      <animate attributeName="opacity" values="0.65;0" dur="0.85s" fill="freeze" />
    </circle>
  );
}

// ─── Sparkline ────────────────────────────────────────────────────────────────
function Sparkline({ buckets, width = 64, height = 18 }) {
  const max = Math.max(1, ...buckets);
  const dx  = width / Math.max(1, buckets.length - 1);
  let pts = "";
  buckets.forEach((v, i) => {
    const x = (i * dx).toFixed(1);
    const y = (height - (v / max) * (height - 2) - 1).toFixed(1);
    pts += (i === 0 ? "M" : "L") + x + " " + y;
  });
  return (
    <svg width={width} height={height} style={{ display: "block" }}>
      <path d={pts} fill="none" stroke="var(--primary)" strokeWidth="1.4"
            strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

// ─── SVG coordinate helper ────────────────────────────────────────────────────
function screenToSVG(svgEl, clientX, clientY) {
  const pt = svgEl.createSVGPoint();
  pt.x = clientX; pt.y = clientY;
  return pt.matrixTransform(svgEl.getScreenCTM().inverse());
}

// ─── SVG flow graph ───────────────────────────────────────────────────────────
function FlowGraph({ nodeHealth, edgeIdx, selected, hovered, onSelect, onHover,
                     packets, onPacketDone, pulses, onPulseDone }) {
  const [nodePos, setNodePos] = useState(() =>
    Object.fromEntries(Object.entries(NODES).map(([id, n]) => [id, { cx: n.cx, cy: n.cy }]))
  );
  const svgRef  = useRef(null);
  const dragRef = useRef(null);
  const [draggingId, setDraggingId] = useState(null);

  const handlePointerDown = useCallback((e, id) => {
    if (!svgRef.current) return;
    e.stopPropagation();
    const svgPt = screenToSVG(svgRef.current, e.clientX, e.clientY);
    dragRef.current = { id, offX: svgPt.x - nodePos[id].cx, offY: svgPt.y - nodePos[id].cy };
    setDraggingId(id);
    svgRef.current.setPointerCapture(e.pointerId);
  }, [nodePos]);

  const handlePointerMove = useCallback((e) => {
    if (!dragRef.current || !svgRef.current) return;
    const svgPt = screenToSVG(svgRef.current, e.clientX, e.clientY);
    const { id, offX, offY } = dragRef.current;
    setNodePos(prev => ({
      ...prev,
      [id]: {
        cx: Math.max(NW/2 + 4, Math.min(SVG_W - NW/2 - 4, svgPt.x - offX)),
        cy: Math.max(NH/2 + 4, Math.min(SVG_H - NH/2 - 4, svgPt.y - offY)),
      },
    }));
  }, []);

  const handlePointerUp = useCallback(() => {
    dragRef.current = null;
    setDraggingId(null);
  }, []);

  const getStatus = id => {
    const h = nodeHealth[id] || {};
    if (h.live === true)  return "online";
    if (h.live === false) return "offline";
    return "unknown";
  };
  const isNodeActive = id =>
    TOPO.some(({ from, to }) => (from === id || to === id) &&
      (edgeIdx[`${from}->${to}`]?.count || 0) > 0);

  // Focus set: when something is selected, dim everything not connected
  const focusSet = useMemo(() => {
    if (!selected) return null;
    const s = new Set();
    if (selected.type === "node") {
      s.add(selected.id);
      TOPO.forEach(({ from, to }) => {
        if (from === selected.id || to === selected.id) { s.add(from); s.add(to); }
      });
    } else if (selected.type === "edge") {
      s.add(selected.from); s.add(selected.to);
    }
    return s;
  }, [selected]);

  return (
    <svg ref={svgRef} viewBox={`0 0 ${SVG_W} ${SVG_H}`} preserveAspectRatio="xMidYMid meet"
      style={{ width: "100%", height: "100%", display: "block", touchAction: "none" }}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onClick={() => onSelect(null)}>
      <defs>
        <filter id="mf-glow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur in="SourceGraphic" stdDeviation="3" result="blur" />
          <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
        </filter>
        <marker id="mf-arr" viewBox="0 0 10 10" refX="9" refY="5"
                markerWidth="5" markerHeight="5" orient="auto">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke" />
        </marker>
      </defs>

      {/* Drag hint */}
      {!draggingId && (
        <text x={SVG_W - 12} y={SVG_H - 10} textAnchor="end"
          fontSize="9" fontFamily="Inter, sans-serif"
          fill="var(--muted-3)" opacity="0.7">
          Sleep nodes om te herpositioneren
        </text>
      )}

      {/* ── Edges ── */}
      {TOPO.map(({ from, to }) => {
        const key  = `${from}->${to}`;
        const e    = edgeIdx[key] || {};
        const { w, op, dash, tint } = edgeVis(e.count, e.errors);
        const path = edgePath(from, to, nodePos);
        const col  = tint ? "var(--hot)" : (e.count ? nc(NODES[from]) : "var(--line-3)");
        const isSel = selected?.type === "edge" && selected.key === key;
        const isHov = hovered?.type  === "edge" && hovered.key  === key;
        const inFocus = !focusSet || (focusSet.has(from) && focusSet.has(to));
        const pid  = `ep-${from}-${to}`;
        const posA = nodePos[from] || NODES[from];
        const posB = nodePos[to]   || NODES[to];
        const mid  = { x: (posA.cx + posB.cx) / 2, y: (posA.cy + posB.cy) / 2 };
        const badgeW = Math.max(28, String(e.count || 0).length * 7 + 14);

        return (
          <g key={key}
            style={{ opacity: inFocus ? 1 : 0.08, cursor: "pointer", transition: "opacity .2s" }}
            onMouseEnter={() => onHover({ type: "edge", key, from, to, data: e })}
            onMouseLeave={() => onHover(null)}
            onClick={ev => { ev.stopPropagation(); onSelect({ type: "edge", key, from, to, data: e }); }}>

            {/* Hit zone */}
            <path d={path} fill="none" stroke="transparent" strokeWidth={22} />

            {/* Glow on hover / selection */}
            {(isSel || isHov) && (
              <path d={path} fill="none" stroke={col}
                strokeWidth={w + 10} opacity={isSel ? 0.18 : 0.12}
                filter="url(#mf-glow)" />
            )}

            {/* Path for animateMotion + arrowhead */}
            <path id={pid} d={path} fill="none" stroke={col}
              strokeWidth={isSel ? w + 1.2 : (isHov ? w + 0.8 : w)}
              strokeDasharray={dash} opacity={op}
              style={{ transition: "stroke-width .15s" }}
              markerEnd="url(#mf-arr)" />

            {/* Crawl animation on idle edges */}
            {!e.count && (
              <path d={path} fill="none" stroke="var(--line-3)"
                strokeWidth="0.9" strokeDasharray="5 6"
                opacity="0.25" className="mf-dash-crawl" />
            )}

            {/* Count badge */}
            {e.count > 0 && (
              <g transform={`translate(${mid.x - badgeW/2}, ${mid.y - 9})`}
                pointerEvents="none">
                <rect width={badgeW} height={17} rx="5"
                  fill="var(--surface)" stroke={col} strokeWidth="1.2" opacity="0.97" />
                <text x={badgeW/2} y={11.5} textAnchor="middle" fontSize="10"
                  fontFamily="JetBrains Mono, monospace" fontWeight="700" fill={col}>
                  {e.count > 9999 ? "9999+" : e.count}
                </text>
              </g>
            )}
          </g>
        );
      })}

      {/* ── One-shot packets ── */}
      {(packets || []).map(pkt => (
        <Packet key={pkt.id} pkt={pkt} onDone={() => onPacketDone(pkt.id)} />
      ))}

      {/* ── Node pulse rings ── */}
      {(pulses || []).map(pu => (
        <NodePulse key={pu.id} pulse={pu} nodePos={nodePos} onDone={() => onPulseDone(pu.id)} />
      ))}

      {/* ── Nodes ── */}
      {Object.entries(NODES).map(([id, node]) => {
        const status   = getStatus(id);
        const active   = isNodeActive(id);
        const isSel    = selected?.type === "node" && selected.id === id;
        const isHov    = hovered?.type  === "node" && hovered.id  === id;
        const inFocus  = !focusSet || focusSet.has(id);
        const isInfra  = id === "monitoring";
        const hc       = status === "online" ? "var(--ok)"
                       : status === "offline" ? "var(--hot)" : "var(--muted-3)";
        const border   = status === "offline" ? "var(--hot)"
                       : (isSel ? nc(node) : (active ? nc(node) : "var(--line-2)"));
        const bw       = isSel ? 2.4 : active ? 1.6 : 1;
        const pos      = nodePos[id] || node;
        const nx = pos.cx - NW/2, ny = pos.cy - NH/2;
        const isDragging = draggingId === id;

        return (
          <g key={id} transform={`translate(${nx}, ${ny})`}
            style={{
              opacity: inFocus ? 1 : 0.2,
              cursor: isDragging ? "grabbing" : "grab",
              transition: isDragging ? "none" : "opacity .2s",
            }}
            onMouseEnter={() => !isDragging && onHover({ type: "node", id, node })}
            onMouseLeave={() => onHover(null)}
            onClick={ev => { if (!dragRef.current) { ev.stopPropagation(); onSelect({ type: "node", id, node }); } }}
            onPointerDown={ev => handlePointerDown(ev, id)}>

            {/* Hover/sel glow */}
            {(isSel || isHov) && (
              <rect x="-6" y="-6" width={NW+12} height={NH+12} rx="14"
                fill={nc(node)} opacity={isSel ? 0.14 : 0.09}
                filter="url(#mf-glow)" />
            )}

            {/* Body */}
            <rect x="0" y="0" width={NW} height={NH} rx="9"
              fill="var(--surface)" stroke={border} strokeWidth={bw}
              style={{ transition: isDragging ? "none" : "stroke .2s, stroke-width .15s" }} />

            {/* Tinted fill when active */}
            {active && (
              <rect x="0" y="0" width={NW} height={NH} rx="9"
                fill={nc(node)} opacity="0.05" />
            )}

            {/* Service name */}
            <text x={NW/2 - 6} y={NH/2 + 4.5} textAnchor="middle"
              fontSize="12" fontWeight="600" fontFamily="Inter, sans-serif"
              fill={active ? "var(--ink)" : "var(--muted)"}>
              {node.label}
            </text>

            {/* INFRA badge */}
            {isInfra && (
              <text x={NW/2 - 6} y={NH - 5} textAnchor="middle"
                fontSize="7.5" fontWeight="700" letterSpacing="0.08em"
                fontFamily="JetBrains Mono, monospace"
                fill={nc(node)} opacity="0.8">INFRA</text>
            )}

            {/* Health dot + pulse */}
            {status === "online" && (
              <circle cx={NW-9} cy={NH/2} r="4" fill="var(--ok)" opacity="0.35">
                <animate attributeName="r"       values="4;9;4"        dur="2.6s" repeatCount="indefinite" />
                <animate attributeName="opacity" values="0.35;0;0.35"  dur="2.6s" repeatCount="indefinite" />
              </circle>
            )}
            <circle cx={NW-9} cy={NH/2} r="4" fill={hc} />
          </g>
        );
      })}
    </svg>
  );
}

// ─── Hover tooltip ────────────────────────────────────────────────────────────
function HoverTooltip({ hovered, edgeIdx, nodeHealth, pos }) {
  if (!hovered || !pos) return null;

  let left = pos.x + 14, top = pos.y - 10;
  if (left + 280 > window.innerWidth) left = pos.x - 260;
  if (top  + 200 > window.innerHeight) top = pos.y - 200;

  let body;
  if (hovered.type === "edge") {
    const e   = edgeIdx[hovered.key] || {};
    const fN  = NODES[hovered.from], tN = NODES[hovered.to];
    const top3 = Object.entries(e.actions || {}).sort((a, b) => b[1] - a[1]).slice(0, 3);
    body = (
      <>
        <div className="mf-tt-title">
          <span style={{ color: nc(fN) }}>{fN?.label || hovered.from}</span>
          <span style={{ color: "var(--muted-3)" }}> → </span>
          <span style={{ color: nc(tN) }}>{tN?.label || hovered.to}</span>
        </div>
        {e.count
          ? <>
              <div className="mf-tt-row"><span>Berichten</span><b>{e.count}</b></div>
              {e.errors > 0 && <div className="mf-tt-row hot"><span>Fouten</span><b>{e.errors} ({Math.round(e.errors/e.count*100)}%)</b></div>}
              {fmtRate(e.rate) && <div className="mf-tt-row"><span>Tempo</span><b>{fmtRate(e.rate)}</b></div>}
              {e.lastMsg && <div className="mf-tt-row"><span>Laatste</span><b>{timeSince(e.lastMsg)}</b></div>}
              {top3.length > 0 && (
                <div style={{ marginTop: 5, display: "flex", gap: 3, flexWrap: "wrap" }}>
                  {top3.map(([a, c]) => (
                    <span key={a} style={{ padding: "1px 6px", background: "var(--surface-3)",
                      borderRadius: 4, fontSize: 10, fontWeight: 600, color: "var(--ink)" }}>
                      {ACTION_NL[a] || a} {c}
                    </span>
                  ))}
                </div>
              )}
            </>
          : <div className="mf-tt-hint">Verbinding gedefinieerd · geen berichten in venster</div>
        }
      </>
    );
  } else if (hovered.type === "node") {
    const id   = hovered.id;
    const h    = nodeHealth[id] || {};
    const stat = h.live === true ? "online" : h.live === false ? "offline" : "onbekend";
    const node = NODES[id];
    const out  = TOPO.filter(t => t.from === id);
    const inn  = TOPO.filter(t => t.to   === id);
    body = (
      <>
        <div className="mf-tt-title" style={{ color: nc(node) }}>{node?.label}</div>
        <div className="mf-tt-row"><span>Status</span>
          <b style={{ color: stat === "online" ? "var(--ok)" : stat === "offline" ? "var(--hot)" : "var(--muted)" }}>
            {stat}
          </b>
        </div>
        {h.uptime != null && <div className="mf-tt-row"><span>Uptime</span><b>{h.uptime}s</b></div>}
        <div style={{ marginTop: 6, fontSize: 10.5 }}>
          {out.map(t => {
            const cnt = edgeIdx[`${t.from}->${t.to}`]?.count || 0;
            return (
              <div key={t.to} style={{ display: "flex", gap: 4, alignItems: "center", padding: "1px 0" }}>
                <span style={{ color: "var(--muted-3)", fontFamily: "var(--font-mono)", fontSize: 9 }}>→</span>
                <span style={{ color: nc(NODES[t.to]), fontWeight: 600 }}>{NODES[t.to]?.label || t.to}</span>
                <span style={{ marginLeft: "auto", fontFamily: "var(--font-mono)", fontWeight: 700,
                  color: cnt ? "var(--ink)" : "var(--muted-3)" }}>{cnt || "—"}</span>
              </div>
            );
          })}
        </div>
      </>
    );
  }

  return (
    <div className="mf-tt" style={{ position: "fixed", left, top, zIndex: 9999, pointerEvents: "none" }}>
      {body}
    </div>
  );
}

// ─── Detail panel (left rail) ─────────────────────────────────────────────────
function DetailPanel({ selected, edgeIdx }) {
  if (!selected) return (
    <div className="mf-detail-hint">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
        <circle cx="11" cy="11" r="7"/><path d="m21 21-3.5-3.5"/>
      </svg>
      <div>Klik op een service of verbinding voor details.</div>
    </div>
  );

  if (selected.type === "node") {
    const { id, node } = selected;
    const out = TOPO.filter(t => t.from === id).map(t => ({
      key: `${t.from}->${t.to}`, ...t, d: edgeIdx[`${t.from}->${t.to}`] || {}
    }));
    const inn = TOPO.filter(t => t.to === id).map(t => ({
      key: `${t.from}->${t.to}`, ...t, d: edgeIdx[`${t.from}->${t.to}`] || {}
    }));
    const totalOut  = out.reduce((s, e) => s + (e.d.count || 0), 0);
    const totalIn   = inn.reduce((s, e) => s + (e.d.count || 0), 0);
    const totalErr  = [...out, ...inn].reduce((s, e) => s + (e.d.errors || 0), 0);
    const recentMsgs = [...out, ...inn]
      .flatMap(e => e.d.recent || [])
      .sort((a, b) => (b.timestamp || "").localeCompare(a.timestamp || ""))
      .slice(0, 12);

    return (
      <div className="mf-detail">
        <div className="mf-detail-hdr">
          <b style={{ color: nc(node) }}>{node.label}</b>
        </div>
        <div className="mf-detail-kv"><span>Inkomend</span><b>{totalIn}</b></div>
        <div className="mf-detail-kv"><span>Uitgaand</span><b>{totalOut}</b></div>
        {totalErr > 0 && <div className="mf-detail-kv hot"><span>Fouten</span><b>{totalErr}</b></div>}
        {out.length > 0 && <div className="mf-detail-sub">Uitgaand</div>}
        {out.map(e => (
          <div key={e.to} style={{ display: "flex", alignItems: "center", padding: "3px 0", fontSize: 11.5 }}>
            <span style={{ color: "var(--muted-3)", marginRight: 4, fontFamily: "var(--font-mono)", fontSize: 9 }}>OUT</span>
            <span style={{ color: nc(NODES[e.to]), fontWeight: 600 }}>{NODES[e.to]?.label || e.to}</span>
            <span style={{ marginLeft: "auto", fontFamily: "var(--font-mono)", fontWeight: 700,
              color: e.d.count ? "var(--ink)" : "var(--muted-3)" }}>{e.d.count || "—"}</span>
          </div>
        ))}
        {inn.length > 0 && <div className="mf-detail-sub">Inkomend</div>}
        {inn.map(e => (
          <div key={e.from} style={{ display: "flex", alignItems: "center", padding: "3px 0", fontSize: 11.5 }}>
            <span style={{ color: "var(--muted-3)", marginRight: 4, fontFamily: "var(--font-mono)", fontSize: 9 }}>IN</span>
            <span style={{ color: nc(NODES[e.from]), fontWeight: 600 }}>{NODES[e.from]?.label || e.from}</span>
            <span style={{ marginLeft: "auto", fontFamily: "var(--font-mono)", fontWeight: 700,
              color: e.d.count ? "var(--ink)" : "var(--muted-3)" }}>{e.d.count || "—"}</span>
          </div>
        ))}
        {recentMsgs.length > 0 && <>
          <div className="mf-detail-sub">Recente berichten</div>
          <div className="mf-detail-log">
            {recentMsgs.map((m, i) => <DetailLogItem key={i} m={m} />)}
          </div>
        </>}
      </div>
    );
  }

  if (selected.type === "edge") {
    const { from, to, data: e } = selected;
    const fN = NODES[from], tN = NODES[to];
    const actions = Object.entries(e.actions || {}).sort((a, b) => b[1] - a[1]);
    return (
      <div className="mf-detail">
        <div className="mf-detail-hdr">
          <b style={{ color: nc(fN) }}>{fN?.label || from}</b>
          <span className="mf-detail-arrow"> → </span>
          <b style={{ color: nc(tN) }}>{tN?.label || to}</b>
        </div>
        {!e.count
          ? <div style={{ padding: "8px 4px", color: "var(--muted-2)", fontSize: 11.5, fontStyle: "italic" }}>
              Geen berichten in dit venster
            </div>
          : <>
              <div className="mf-detail-kv"><span>Berichten</span><b>{e.count}</b></div>
              {e.errors > 0 && <div className="mf-detail-kv hot"><span>Fouten</span>
                <b>{e.errors} ({Math.round(e.errors/e.count*100)}%)</b></div>}
              {fmtRate(e.rate) && <div className="mf-detail-kv"><span>Tempo</span><b>{fmtRate(e.rate)}</b></div>}
              {e.lastMsg && <div className="mf-detail-kv"><span>Laatste</span><b>{timeSince(e.lastMsg)}</b></div>}
              {actions.length > 0 && <>
                <div className="mf-detail-sub">Per type</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 6 }}>
                  {actions.map(([a, c]) => (
                    <span key={a} className="mf-detail-tag">
                      {ACTION_NL[a] || a}
                      <span style={{ marginLeft: 4, color: "var(--muted)" }}>{c}</span>
                    </span>
                  ))}
                </div>
              </>}
              {e.recent?.length > 0 && <>
                <div className="mf-detail-sub">Recente berichten</div>
                <div className="mf-detail-log">
                  {e.recent.map((m, i) => <DetailLogItem key={i} m={m} />)}
                </div>
              </>}
            </>
        }
      </div>
    );
  }
  return null;
}

// ─── Left rail ────────────────────────────────────────────────────────────────
function LeftRail({ nodes, edgeIdx, liveEvents, errCount, selected, onSelect, hours }) {
  const nodeMap = useMemo(() => Object.fromEntries((nodes || []).map(n => [n.id, n])), [nodes]);

  const svcCounts = useMemo(() => {
    const c = {};
    for (const id of Object.keys(NODES)) c[id] = 0;
    for (const ev of liveEvents) {
      const dst = ev.destinations?.[0];
      if (c[ev.source] != null) c[ev.source]++;
      if (dst && c[dst] != null) c[dst]++;
    }
    return c;
  }, [liveEvents]);

  const totalMsgs   = useMemo(() => liveEvents.length, [liveEvents]);
  const activeFlows = useMemo(
    () => Object.values(edgeIdx).filter(e => e.count > 0).length,
    [edgeIdx]
  );

  return (
    <div className="mf-rail">
      <div className="mf-rail-section">
        <h3 className="mf-rail-title">
          {hours === null ? "Live" : "Historisch"}
          <span className="sub"> — {hours === null ? "5 min. venster" : hours < 1 ? `${Math.round(hours*60)}m` : `${hours}u`}</span>
        </h3>
        <div className="mf-readout">
          <div className="mf-rd">
            <div className="mf-rd-v">{totalMsgs}</div>
            <div className="mf-rd-l">berichten</div>
          </div>
          <div className={`mf-rd ${errCount > 0 ? "hot" : ""}`}>
            <div className="mf-rd-v">{errCount}</div>
            <div className="mf-rd-l">fouten</div>
          </div>
        </div>
      </div>

      <div className="mf-rail-section">
        <h3 className="mf-rail-title">Services
          <span className="sub"> {activeFlows}/{TOPO.length} flows actief</span>
        </h3>
        <div className="mf-svcs">
          {Object.entries(NODES).map(([id, node]) => {
            const nd     = nodeMap[id] || {};
            const status = nd.live === true ? "online" : nd.live === false ? "offline" : "unknown";
            const cnt    = svcCounts[id] || 0;
            const isSel  = selected?.type === "node" && selected.id === id;
            return (
              <button key={id}
                className={`mf-svc ${cnt === 0 ? "idle" : ""} ${isSel ? "on" : ""}`}
                style={{ "--svc-c": nc(node) }}
                onClick={() => onSelect(isSel ? null : { type: "node", id, node })}>
                <div className="mf-svc-bar" />
                <div className={`mf-svc-health ${status}`} />
                <div className="mf-svc-name">{node.label}</div>
                <div className="mf-svc-count">{cnt || "—"}</div>
              </button>
            );
          })}
        </div>
      </div>

      <div className="mf-rail-section" style={{ flex: 1, minHeight: 0 }}>
        <h3 className="mf-rail-title">Detail</h3>
        <DetailPanel selected={selected} edgeIdx={edgeIdx} />
      </div>
    </div>
  );
}

// ─── Feed item ────────────────────────────────────────────────────────────────
function FeedItem({ ev, onSelect, edgeIdx }) {
  const sN = NODES[ev.source];
  const dst = ev.destinations?.[0];
  const tN = dst ? NODES[dst] : null;
  const isNew = !ev.isCached && (Date.now() - new Date(ev.timestamp).getTime()) < 2500;

  const handleClick = () => {
    if (!onSelect) return;
    if (ev.source && dst) {
      const key = `${ev.source}->${dst}`;
      onSelect({ type: "edge", key, from: ev.source, to: dst, data: (edgeIdx || {})[key] || {} });
    } else if (ev.source && NODES[ev.source]) {
      onSelect({ type: "node", id: ev.source, node: NODES[ev.source] });
    }
  };

  return (
    <div className={`mf-fi lvl-${ev.level}${isNew ? " entering" : ""}${ev.isCached ? " cached" : ""}`}
      style={{ "--svc-c": nc(sN), "--svc-c-dst": nc(tN), cursor: onSelect ? "pointer" : "default" }}
      onClick={handleClick}
      title={dst ? `Selecteer: ${sN?.label || ev.source} → ${tN?.label || dst}` : undefined}>
      <div className="mf-fi-ts">
        {fmtTime(ev.timestamp)}
        {!ev.isCached && <span className="ago">{ago(ev.timestamp)}</span>}
        {ev.isCached && <span className="ago" style={{ color: "var(--muted-3)" }}>cache</span>}
      </div>
      <div className="mf-fi-body">
        <div className="mf-fi-line1">
          <span className="mf-fi-src">{sN?.label || ev.source}</span>
          {tN && <>
            <span className="mf-fi-arrow">→</span>
            <span className="mf-fi-dst">{tN.label}</span>
          </>}
          <span className="mf-fi-action">{ACTION_NL[ev.action] || ev.action}</span>
        </div>
        {ev.message && <div className="mf-fi-msg" style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{ev.message}</div>}
      </div>
    </div>
  );
}

// ─── Filter chips ─────────────────────────────────────────────────────────────
function FilterChips({ events, actionFilter, setActionFilter, levelFilter, setLevelFilter }) {
  const topActions = useMemo(() => {
    const c = {};
    for (const e of events) c[e.action] = (c[e.action] || 0) + 1;
    return Object.entries(c).sort((a, b) => b[1] - a[1]).slice(0, 6);
  }, [events]);
  const lvlCounts = useMemo(() => {
    const c = { error: 0, warning: 0 };
    for (const e of events) if (c[e.level] != null) c[e.level]++;
    return c;
  }, [events]);

  return (
    <div className="mf-chips">
      <button className={`mf-chip ${!actionFilter && !levelFilter ? "on" : ""}`}
        onClick={() => { setActionFilter(null); setLevelFilter(null); }}>
        Alles <span className="mf-chip-c">{events.length}</span>
      </button>
      {lvlCounts.error > 0 && (
        <button className={`mf-chip mf-chip-lvl-error ${levelFilter === "error" ? "on" : ""}`}
          onClick={() => setLevelFilter(f => f === "error" ? null : "error")}>
          Fouten <span className="mf-chip-c">{lvlCounts.error}</span>
        </button>
      )}
      {lvlCounts.warning > 0 && (
        <button className={`mf-chip mf-chip-lvl-warning ${levelFilter === "warning" ? "on" : ""}`}
          onClick={() => setLevelFilter(f => f === "warning" ? null : "warning")}>
          Waarsch. <span className="mf-chip-c">{lvlCounts.warning}</span>
        </button>
      )}
      {topActions.map(([a, c]) => (
        <button key={a}
          className={`mf-chip ${actionFilter === a ? "on" : ""}`}
          onClick={() => setActionFilter(f => f === a ? null : a)}>
          {ACTION_NL[a] || a} <span className="mf-chip-c">{c}</span>
        </button>
      ))}
    </div>
  );
}

// ─── Live feed panel ──────────────────────────────────────────────────────────
function Feed({ events, rate, connected, paused, onTogglePause, onSelect, edgeIdx, isLive }) {
  const [actionFilter, setActionFilter] = useState(null);
  const [levelFilter,  setLevelFilter]  = useState(null);
  const [search,       setSearch]       = useState("");
  const [hovering,     setHovering]     = useState(false);
  const visibleRef = useRef([]);
  const listRef    = useRef(null);

  // Load cached logs once when live feed is empty
  const [cachedEvents, setCachedEvents] = useState([]);
  const hasFetchedCached = useRef(false);
  useEffect(() => {
    if (events.length > 0) { hasFetchedCached.current = true; return; }
    if (hasFetchedCached.current) return;
    hasFetchedCached.current = true;
    fetch('/api/logs/cached?limit=100')
      .then(r => { if (!r.ok) throw new Error(`Server ${r.status}`); return r.json(); })
      .then(d => {
        setCachedEvents((d.logs || []).slice(0, 120).map(log => ({
          source: log.source || "unknown",
          action: log.action || "unknown",
          message: log.message || "",
          timestamp: log.timestamp || new Date().toISOString(),
          level: log.level || "info",
          destinations: [],
          isCached: true,
        })));
      })
      .catch(() => {});
  }, [events.length]);

  const displayEvents = events.length > 0 ? events : cachedEvents;

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return displayEvents.filter(e => {
      if (actionFilter && e.action !== actionFilter) return false;
      if (levelFilter  && e.level  !== levelFilter)  return false;
      if (q) {
        const hay = `${e.message} ${e.source} ${(e.destinations || []).join(" ")} ${e.action}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [displayEvents, actionFilter, levelFilter, search]);

  // Freeze list while hovering over it; count stashed new items
  useEffect(() => {
    if (!hovering) visibleRef.current = filtered;
  }, [hovering, filtered]);

  const visible      = hovering ? visibleRef.current : filtered;
  const stashedCount = hovering
    ? Math.max(0, filtered.length - (visibleRef.current?.length || 0))
    : 0;

  const flush = () => {
    visibleRef.current = filtered;
    if (listRef.current) listRef.current.scrollTop = 0;
    setHovering(false);
  };

  const isCachedMode = events.length === 0 && cachedEvents.length > 0;

  return (
    <aside className="mf-feed">
      <header className="mf-feed-head">
        <div className="mf-feed-title">
          <span>{isLive ? "Live berichten" : "Historische berichten"}</span>
          <span className="mf-feed-rate">
            {isLive
              ? (connected
                  ? <>{rate.toFixed(1)}<span style={{ color: "var(--muted-3)" }}> msg/s</span></>
                  : <span style={{ color: "var(--warn)" }}>verbinden…</span>)
              : <span style={{ color: "var(--muted-2)" }}>historisch</span>}
            {isCachedMode && <span style={{ marginLeft: 6, color: "var(--muted-2)", fontSize: 10 }}>· gecached</span>}
          </span>
        </div>
        <div className="mf-feed-search">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="7"/><path d="m20 20-3-3"/>
          </svg>
          <input type="text" placeholder="Zoek in berichten…"
            value={search} onChange={e => setSearch(e.target.value)} />
          {search && (
            <button onClick={() => setSearch("")} style={{
              background: "none", border: 0, cursor: "pointer",
              color: "var(--muted-2)", padding: 0, fontSize: 11
            }}>✕</button>
          )}
        </div>
        <FilterChips events={displayEvents}
          actionFilter={actionFilter} setActionFilter={setActionFilter}
          levelFilter={levelFilter}   setLevelFilter={setLevelFilter} />
      </header>

      {isLive && paused && (
        <div className="mf-pause-strip" onClick={onTogglePause} style={{ cursor: "pointer" }}>
          ⏸ Gepauzeerd · klik om te hervatten
        </div>
      )}

      <div className="mf-newpill-wrap">
        <button className={`mf-newpill ${isLive && stashedCount > 0 && hovering ? "show" : ""}`}
          onClick={flush}>
          <span className="pulse" />
          {stashedCount} {stashedCount === 1 ? "nieuw bericht" : "nieuwe berichten"}
        </button>
      </div>

      <div className="mf-feed-list" ref={listRef}
        onMouseEnter={() => setHovering(true)}
        onMouseLeave={() => setHovering(false)}>
        {visible.length === 0 && (
          <div className="mf-feed-empty">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" strokeWidth="1.4">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
            </svg>
            <div>Geen berichten</div>
            <span className="hint">
              {search || actionFilter || levelFilter
                ? "Pas filters aan om meer te zien"
                : "Wachten op nieuwe berichten…"}
            </span>
          </div>
        )}
        {visible.slice(0, 200).map((ev, i) => (
          <FeedItem key={`${ev.timestamp}|${ev.source}|${ev.action}|${i}`} ev={ev}
            onSelect={onSelect} edgeIdx={edgeIdx} />
        ))}
      </div>
    </aside>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────
function MessageFlowScreen() {
  const [data,        setData]        = useState(null);
  const [loading,     setLoading]     = useState(true);
  const [error,       setError]       = useState(null);
  const [hours,       setHours]       = useState(null);   // null = Live mode
  const [paused,      setPaused]      = useState(false);
  const [connState,   setConnState]   = useState("connected");
  const [selected,    setSelected]    = useState(null);
  const [hovered,     setHovered]     = useState(null);
  const [tooltipPos,  setTooltipPos]  = useState(null);
  const [liveEvents,  setLiveEvents]  = useState([]);
  const [packets,     setPackets]     = useState([]);
  const [pulses,      setPulses]      = useState([]);
  const [buckets,     setBuckets]     = useState(() => new Array(60).fill(0));
  const [now,         setNow]         = useState(Date.now());

  const seenKeys  = useRef(new Set());
  const packetSeq = useRef(0);
  const pulseSeq  = useRef(0);

  // Tick "now" once/s so ago() timestamps stay live
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // ── Fetch ──
  const fetchData = useCallback(() => {
    const live = hours === null;
    const apiHours = live ? 0.083 : hours;
    fetch(`/api/monitoring/message-flow?hours=${apiHours}&limit=1000`)
      .then(r => { if (!r.ok) throw new Error(`Server ${r.status}`); return r.json(); })
      .then(d => {
        setData(d);
        setError(null);
        setLoading(false);
        setConnState("connected");

        if (!live) {
          // Historical mode: replace entirely, no accumulation
          setLiveEvents(d.recent_events || []);
          return;
        }

        // Live mode: accumulate new events, deduplicate
        const incoming = (d.recent_events || []).filter(e => {
          const k = eventKey(e);
          if (seenKeys.current.has(k)) return false;
          seenKeys.current.add(k);
          return true;
        });
        if (incoming.length > 0) {
          setLiveEvents(prev => [...incoming, ...prev].slice(0, 400));
          // Spawn packets
          const topoSet = new Set(TOPO.map(t => `${t.from}->${t.to}`));
          const newPkts = incoming
            .map(e => ({ ...e, to: e.destinations?.[0] }))
            .filter(e => e.source && e.to && topoSet.has(`${e.source}->${e.to}`))
            .slice(0, 6)
            .map((e, i) => ({
              id:    `pkt-${++packetSeq.current}`,
              from:  e.source,
              to:    e.to,
              dur:   1500 + Math.random() * 800,
              delay: i * 180,
              level: e.level || "info",
            }));
          if (newPkts.length > 0) {
            setPackets(prev => [...prev.slice(-20), ...newPkts]);
            newPkts.forEach(pkt => {
              setTimeout(() => {
                setPulses(prev => [
                  ...prev.slice(-12),
                  { id: `pu-${++pulseSeq.current}`, nodeId: pkt.to, level: pkt.level },
                ]);
              }, (pkt.delay || 0) + pkt.dur * 0.62);
            });
          }
        }
      })
      .catch(e => {
        const msg = e.message || String(e);
        setConnState("reconnecting");
        setError(msg.includes("502") || msg.includes("503")
          ? "Server herstart… even geduld"
          : msg);
        setLoading(false);
      });
  }, [hours]);

  // Reset on window/pause change
  useEffect(() => {
    seenKeys.current.clear();
    setLiveEvents([]);
    setLoading(true);
    fetchData();
  }, [fetchData]);

  // Auto-poll only in live mode and when not paused (does NOT trigger the reset effect)
  useEffect(() => {
    if (hours !== null || paused) return;
    const id = setInterval(fetchData, 10_000);
    return () => clearInterval(id);
  }, [fetchData, paused]);

  // Bucket throughput (last 60s) for sparkline
  useEffect(() => {
    const id = setInterval(() => {
      const cutoff = Date.now() - 60_000;
      const next = new Array(60).fill(0);
      for (const e of liveEvents) {
        const t = new Date(e.timestamp).getTime();
        if (t > cutoff) {
          const bi = Math.min(59, Math.max(0, Math.floor((t - cutoff) / 1000)));
          next[bi]++;
        }
      }
      setBuckets(next);
    }, 1000);
    return () => clearInterval(id);
  }, [liveEvents]);

  const liveRate = useMemo(() => {
    const cutoff = now - 10_000;
    return liveEvents.filter(e => new Date(e.timestamp).getTime() > cutoff).length / 10;
  }, [liveEvents, now]);

  const errCount = useMemo(
    () => liveEvents.filter(e => e.level === "error").length,
    [liveEvents]
  );

  const edgeIdx    = useMemo(() => buildEdgeIdx(data?.edges), [data?.edges]);
  const nodeHealth = useMemo(() => {
    const h = {};
    for (const n of (data?.nodes || [])) h[n.id] = n;
    return h;
  }, [data?.nodes]);

  const handleSelect = useCallback(item => {
    if (!item) { setSelected(null); return; }
    setSelected(prev => {
      if (!prev) return item;
      const same = (item.type === "node" && prev.type === "node" && prev.id === item.id)
                || (item.type === "edge" && prev.type === "edge" && prev.key === item.key);
      return same ? null : item;
    });
  }, []);

  const handleMouseMove = useCallback(e => {
    setTooltipPos({ x: e.clientX, y: e.clientY });
  }, []);

  const isLive = hours === null;

  const WINDOWS = [
    { l: "Live", h: null  },
    { l: "15m",  h: 0.25  },
    { l: "1u",   h: 1     },
    { l: "6u",   h: 6     },
    { l: "7u",   h: 7     },
  ];

  return (
    <div className="mf-screen" onMouseMove={handleMouseMove}>

      {/* ── Header ── */}
      <header className="mf-head">
        <div className="mf-brand">
          <div className="glyph">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
              stroke="white" strokeWidth="2.4">
              <circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/>
              <circle cx="18" cy="19" r="3"/>
              <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/>
              <line x1="15.41" y1="6.51"  x2="8.59"  y2="10.49"/>
            </svg>
          </div>
          Live Berichtenflow
          <span className="sub">· {TOPO.length} verbindingen</span>
        </div>

        <div className="mf-head-sep" />

        <div className="mf-spark" title="Berichten per seconde (laatste 60s)">
          <Sparkline buckets={buckets} />
          <span className="mf-spark-rate">{liveRate.toFixed(1)}</span>
          <span className="mf-spark-unit">msg/s</span>
        </div>

        <div className="mf-head-spacer" />

        <div className="mf-windows">
          {WINDOWS.map(w => (
            <button key={w.l}
              className={`mf-win ${hours === w.h ? "on" : ""} ${w.h === null ? "is-live" : ""}`}
              onClick={() => { setHours(w.h); setPaused(false); setSelected(null); }}>
              {w.h === null && <span className="mf-live-dot" />}
              {w.l}
            </button>
          ))}
        </div>

        {isLive && (
          <button
            className={`mf-icon-btn ${paused ? "" : "active"}`}
            onClick={() => setPaused(p => !p)}
            title={paused ? "Klik om live te hervatten" : "Klik om te pauzeren"}
            style={{ fontSize: 13, padding: "0 8px" }}>
            {paused ? "▶" : "⏸"}
          </button>
        )}

        <button className="mf-icon-btn" onClick={fetchData} title="Nu vernieuwen">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="2.5">
            <polyline points="23 4 23 10 17 10"/>
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
          </svg>
        </button>
      </header>

      {/* ── Body ── */}
      <div className="mf-body">
        <LeftRail
          nodes={data?.nodes}
          edgeIdx={edgeIdx}
          liveEvents={liveEvents}
          errCount={errCount}
          selected={selected}
          onSelect={handleSelect}
          hours={hours}
        />

        <main className="mf-canvas">
          {loading && !data && (
            <div className="mf-loading"><span className="mf-spin"></span> Laden…</div>
          )}
          {error && (
            <div className="mf-error" style={{ position: "absolute", bottom: 16, right: 16,
              zIndex: 5, padding: "8px 14px", borderRadius: 6, background: "var(--surface)",
              border: "1px solid var(--line)", fontSize: 12 }}>
              <b>Fout:</b> {error}
            </div>
          )}
          {(!loading || data) && (
            <FlowGraph
              nodeHealth={nodeHealth}
              edgeIdx={edgeIdx}
              selected={selected}
              hovered={hovered}
              onSelect={handleSelect}
              onHover={setHovered}
              packets={packets}
              onPacketDone={id => setPackets(prev => prev.filter(p => p.id !== id))}
              pulses={pulses}
              onPulseDone={id => setPulses(prev => prev.filter(p => p.id !== id))}
            />
          )}

          {/* Compact legend */}
          <div className="mf-legend">
            <div className="mf-legend-it">
              <span className="mf-legend-bar" style={{ background: "var(--svc-crm)" }} />
              Actief
            </div>
            <div className="mf-legend-it">
              <span className="mf-legend-bar" style={{ background: "var(--hot)" }} />
              Fouten &gt;15%
            </div>
            <div className="mf-legend-it">
              <span className="mf-legend-bar"
                style={{ background: "var(--line-3)", opacity: .6 }} />
              Geen logs
            </div>
            <div className="mf-legend-it">
              <span className="mf-legend-dot" style={{ background: "var(--ok)" }} />
              Online
            </div>
          </div>
        </main>

        <Feed
          events={liveEvents}
          rate={liveRate}
          connected={connState === "connected"}
          paused={paused}
          onTogglePause={() => setPaused(p => !p)}
          onSelect={handleSelect}
          edgeIdx={edgeIdx}
          isLive={isLive}
        />
      </div>

      <HoverTooltip hovered={hovered} edgeIdx={edgeIdx}
        nodeHealth={nodeHealth} pos={tooltipPos} />
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
})();
