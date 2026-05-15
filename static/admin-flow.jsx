/* eslint-disable no-undef */
/* ============================================================
   MCP Topology — permanently visible flow visualizer
   ============================================================ */
const { useEffect, useMemo, useRef, useState } = React;

function FlowTopology({ activeNodes, doneNodes, activeEdges }) {
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
          return (
            <foreignObject key={id}
              x={n.x} y={n.y} width="130" height="44"
              style={{ overflow: "visible" }}>
              <div
                xmlns="http://www.w3.org/1999/xhtml"
                className={`fnode-html ${active ? "is-active" : ""} ${done ? "is-done" : ""} ${n.llama ? "is-llama" : ""}`}
                data-svc={n.svc}
                style={{ width: "130px" }}
              >
                <div className="dot">{n.icon}</div>
                <div className="text">
                  <span className="name">{n.label}</span>
                  <span className="meta">{n.meta}</span>
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

function MCPServerList({ active }) {
  return (
    <div style={{ padding: "12px 14px", display: "flex", flexDirection: "column", gap: 6, overflowY: "auto" }}>
      {MCP_SERVERS.map((s) => (
        <div key={s.id}
          className="fnode-html"
          data-svc={s.id}
          style={{ width: "100%", padding: "8px 10px" }}
        >
          <div className="dot">{s.id[0].toUpperCase()}</div>
          <div className="text" style={{ flex: 1 }}>
            <span className="name" style={{ textTransform: "capitalize" }}>{s.id}</span>
            <span className="meta">localhost:{s.port}/mcp · {s.tools} tools</span>
          </div>
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap", justifyContent: "flex-end", maxWidth: 180 }}>
            {s.list.slice(0, 2).map((t) => (
              <span key={t} className="mono" style={{
                fontSize: 9.5, padding: "1px 6px", borderRadius: 999,
                background: "var(--surface-2)", border: "1px solid var(--line)",
                color: "var(--muted)",
              }}>{t}</span>
            ))}
            {s.list.length > 2 && (
              <span className="mono" style={{
                fontSize: 9.5, padding: "1px 6px", borderRadius: 999,
                background: "var(--surface-3)", color: "var(--muted)",
              }}>+{s.list.length - 2}</span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------- Monitoring panel: real-time heartbeat overview ----------
const MON_SERVICES = [
  { id: "crm",        label: "CRM",              status: "online",     uptime: "23h 14m", lastSeen: 1,  hbps: 1.0 },
  { id: "facturatie", label: "Facturatie",       status: "online",     uptime: "23h 14m", lastSeen: 1,  hbps: 1.0 },
  { id: "frontend",   label: "Frontend",         status: "online",     uptime: "12h 41m", lastSeen: 1,  hbps: 1.0 },
  { id: "kassa",      label: "Kassa",            status: "degraded",   uptime: "23h 14m", lastSeen: 2,  hbps: 0.4, note: "p95 1.4s" },
  { id: "planning",   label: "Planning",         status: "online",     uptime: "23h 14m", lastSeen: 1,  hbps: 1.0 },
  { id: "mailing",    label: "Mailing",          status: "quarantine", uptime: "—",        lastSeen: 612, hbps: 0,    note: "no heartbeat 10m" },
  { id: "monitoring", label: "Monitoring",       status: "online",     uptime: "23h 14m", lastSeen: 1,  hbps: 1.0 },
  { id: "identity",   label: "Identity Service", status: "online",     uptime: "23h 14m", lastSeen: 1,  hbps: 1.0 },
];

function MonitoringPanel() {
  // Trigger a re-render every second so the heartbeat dots animate live
  const [tick, setTick] = useState(0);
  const [selected, setSelected] = useState(null);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const online       = MON_SERVICES.filter((s) => s.status === "online").length;
  const degraded     = MON_SERVICES.filter((s) => s.status === "degraded").length;
  const quarantined  = MON_SERVICES.filter((s) => s.status === "quarantine").length;
  const totalHbps    = MON_SERVICES.reduce((a, s) => a + s.hbps, 0).toFixed(1);

  const overallStatus = quarantined > 0 || degraded > 0 ? "warn" : "ok";
  const summaryLabel  = overallStatus === "ok"
    ? "All systems operational"
    : `${degraded} degraded · ${quarantined} quarantined`;

  return (
    <div className="mon-pane">
      {/* Hero summary */}
      <div className={`mon-hero ${overallStatus}`}>
        <div className="mon-hero-dot"></div>
        <div className="mon-hero-text">
          <b>{summaryLabel}</b>
          <span>Last updated <span className="mono">just now</span> · refreshing every 5s</span>
        </div>
        <span className="mon-hero-time mono">{new Date().toLocaleTimeString([], { hour12: false })}</span>
      </div>

      {/* KPI row */}
      <div className="mon-kpis">
        <div className="mon-kpi">
          <div className="v mono">{totalHbps}</div>
          <div className="l">Heartbeats / s</div>
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
          <div className="l">Quarantine</div>
        </div>
      </div>

      {/* Service rows with live heartbeat strip */}
      <div className="mon-list">
        <div className="mon-list-head">
          <span>Service</span>
          <span>Heartbeat · last 60s</span>
          <span style={{ textAlign: "right" }}>Status</span>
        </div>
        {MON_SERVICES.map((s) => (
          <MonRow key={s.id} svc={s} tick={tick} onOpen={() => setSelected(s)} />
        ))}
      </div>

      <div className="mon-footer">
        <span className="mono" style={{ color: "var(--muted-2)" }}>
          source: heartbeats-* · index time {Math.floor(Math.random() * 8 + 2)}ms
        </span>
        <button className="mon-link mono">View raw in Elasticsearch →</button>
      </div>

      {selected && (
        <ServiceDetailDrawer svc={selected} tick={tick} onClose={() => setSelected(null)} />
      )}
    </div>
  );
}

function MonRow({ svc, tick, onOpen }) {
  // Generate 60 cells representing the last 60 seconds of heartbeats
  // For online services: all green. For degraded: occasional miss. For quarantine: all red after a point.
  const cells = useMemo(() => {
    const out = [];
    for (let i = 0; i < 60; i++) {
      if (svc.status === "online") {
        out.push("ok");
      } else if (svc.status === "degraded") {
        // ~30% misses, clustered
        const noise = (i * 9301 + 49297) % 233280;
        out.push(noise / 233280 < 0.3 ? "miss" : "ok");
      } else if (svc.status === "quarantine") {
        // Last heartbeat was 612s ago; everything in last 60s is missing
        out.push("miss");
      }
    }
    return out;
  }, [svc.status]);

  // Rotate the visible window so it looks live
  const shifted = useMemo(() => {
    const offset = tick % cells.length;
    return [...cells.slice(offset), ...cells.slice(0, offset)];
  }, [cells, tick]);

  const sinceLabel = svc.lastSeen < 5
    ? `${svc.lastSeen}s ago`
    : svc.lastSeen < 60
      ? `${svc.lastSeen}s ago`
      : svc.lastSeen < 3600
        ? `${Math.floor(svc.lastSeen / 60)}m ago`
        : `${Math.floor(svc.lastSeen / 3600)}h ago`;

  return (
    <button className={`mon-row ${svc.status}`} onClick={onOpen} type="button">
      <div className="mon-row-svc">
        <span className={`mon-dot ${svc.status}`}></span>
        <div className="mon-row-name">
          <b>{svc.label}</b>
          <span className="mono">{sinceLabel}{svc.note ? ` · ${svc.note}` : ""}</span>
        </div>
      </div>
      <div className="mon-strip">
        {shifted.map((c, i) => <span key={i} className={`hb hb-${c}`}></span>)}
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

  // Synthesize realistic detail data based on service id
  const meta = {
    crm:        { version: "2.4.1", host: "crm-prod-01.shift.be",      port: 8080, deps: ["postgres", "identity"], reqMin: 142 },
    facturatie: { version: "1.8.3", host: "facturatie-prod.shift.be",  port: 8443, deps: ["postgres", "identity"], reqMin: 38  },
    frontend:   { version: "drupal-11.0.2", host: "www.shift.be",      port: 443,  deps: ["nginx", "redis"],       reqMin: 1840 },
    kassa:      { version: "0.9.7-rc2", host: "kassa-prod.shift.be",   port: 8090, deps: ["postgres", "facturatie"], reqMin: 67 },
    planning:   { version: "1.3.0", host: "planning-prod.shift.be",    port: 8100, deps: ["postgres", "identity"], reqMin: 24 },
    mailing:    { version: "0.4.2", host: "mailing-prod.shift.be",     port: 8110, deps: ["smtp", "identity"],     reqMin: 0  },
    monitoring: { version: "1.0.0", host: "monitoring-prod.shift.be",  port: 8200, deps: ["elasticsearch"],         reqMin: 480 },
    identity:   { version: "2.1.0", host: "identity-prod.shift.be",    port: 8443, deps: ["postgres"],              reqMin: 220 },
  }[svc.id] || { version: "—", host: "—", port: 0, deps: [], reqMin: 0 };

  const latency = isHot ? { p50: "—", p95: "—" }
                 : isWarn ? { p50: "82ms",  p95: "1.4s"  }
                          : { p50: "12ms",  p95: "48ms"  };

  // Last 10 heartbeats — fake but believable timestamps
  const now = Date.now();
  const heartbeats = [];
  for (let i = 0; i < 10; i++) {
    const sec = i + 1;
    let status = "ok";
    if (isHot) status = "miss";
    else if (isWarn && (i === 2 || i === 5 || i === 7)) status = "slow";
    heartbeats.push({ t: new Date(now - sec * 1000).toLocaleTimeString([], { hour12: false }), status });
  }

  // Recent log lines specific to status
  const logs = isHot ? [
    { lvl: "error",   t: "10:12:04", msg: "no heartbeat received in 600s — quarantining" },
    { lvl: "warning", t: "10:02:18", msg: "connection to smtp.shift.be timed out" },
    { lvl: "warning", t: "09:58:01", msg: "retry 3/3 failed — giving up" },
  ] : isWarn ? [
    { lvl: "warning", t: "23:31:14", msg: "p95 latency exceeded threshold (1.4s > 800ms)" },
    { lvl: "warning", t: "23:30:41", msg: "slow query · invoices_by_member · 1230ms" },
    { lvl: "info",    t: "23:29:02", msg: "auto-scaled to 3 replicas" },
  ] : [
    { lvl: "info",    t: "23:31:16", msg: "heartbeat ok · uptime " + svc.uptime },
    { lvl: "info",    t: "23:28:02", msg: "GET /healthz 200 · 8ms" },
    { lvl: "info",    t: "23:25:11", msg: "config reloaded successfully" },
  ];

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
              <div className="l">Version</div>
              <div className="v mono">{meta.version}</div>
            </div>
            <div className="svc-stat">
              <div className="l">p50 / p95</div>
              <div className="v mono">{latency.p50} / <span style={{color: isWarn ? "var(--warn)" : "inherit"}}>{latency.p95}</span></div>
            </div>
            <div className="svc-stat">
              <div className="l">req/min</div>
              <div className="v mono">{meta.reqMin}</div>
            </div>
          </div>

          {/* Heartbeat sparkline · last 60s — bigger version of the row strip */}
          <section className="svc-section">
            <h4>Heartbeat · last 60s</h4>
            <BigStrip svc={svc} tick={tick} />
            <div className="svc-section-foot mono">
              {svc.status === "online" ? "60 ok · 0 miss" :
               svc.status === "degraded" ? "42 ok · 18 slow" :
               "0 ok · 60 miss"}
            </div>
          </section>

          {/* Last 10 heartbeats */}
          <section className="svc-section">
            <h4>Last 10 heartbeats</h4>
            <div className="svc-hb-list">
              {heartbeats.map((hb, i) => (
                <div key={i} className={`svc-hb-row ${hb.status}`}>
                  <span className="t mono">{hb.t}</span>
                  <span className="dot"></span>
                  <span className="label">{hb.status === "ok" ? "ok" : hb.status === "slow" ? "slow · >800ms" : "missed"}</span>
                  <span className="corr mono">corr_{Math.random().toString(36).slice(2, 8)}</span>
                </div>
              ))}
            </div>
          </section>

          {/* Recent logs */}
          <section className="svc-section">
            <h4>Recent logs</h4>
            <div className="svc-logs">
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
  const cells = useMemo(() => {
    const out = [];
    for (let i = 0; i < 60; i++) {
      if (svc.status === "online") out.push("ok");
      else if (svc.status === "degraded") {
        const noise = (i * 9301 + 49297) % 233280;
        out.push(noise / 233280 < 0.3 ? "slow" : "ok");
      } else out.push("miss");
    }
    return out;
  }, [svc.status]);
  const shifted = useMemo(() => {
    const offset = tick % cells.length;
    return [...cells.slice(offset), ...cells.slice(0, offset)];
  }, [cells, tick]);
  return (
    <div className="svc-big-strip">
      {shifted.map((c, i) => <span key={i} className={`hb-big hb-${c}`}></span>)}
    </div>
  );
}

function FlowColumn({ activeNodes, doneNodes, activeEdges, log, onClear, stats, tab, setTab }) {
  return (
    <aside className="flow-col">
      <div className="flow-head">
        <h2>MCP Topology</h2>
        <span className="sub">5 servers · 16 tools</span>
        <div className="flow-head-spacer"></div>
        <span className="live">LIVE</span>
      </div>

      <div className="flow-tabs">
        <button className={`flow-tab ${tab === "graph"   ? "is-active" : ""}`} onClick={() => setTab("graph")}>Flow graph</button>
        <button className={`flow-tab ${tab === "servers" ? "is-active" : ""}`} onClick={() => setTab("servers")}>
          Servers <span className="count">5</span>
        </button>
        <button className={`flow-tab ${tab === "monitoring" ? "is-active" : ""}`} onClick={() => setTab("monitoring")}>
          Monitoring <span className="count">8</span>
        </button>
      </div>

      {tab === "graph" && (
        <FlowTopology
          activeNodes={activeNodes}
          doneNodes={doneNodes}
          activeEdges={activeEdges}
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
