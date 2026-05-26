/* eslint-disable no-undef */
/* ============================================================
   Shift Festival — Admin Console (app entry)
   Real WebSocket integration — MCP tool calls update the flow graph live
   ============================================================ */

const { useEffect, useMemo, useRef, useState, useCallback } = React;

// ─── Icons ────────────────────────────────────────────────────────────────
const I = {
  plus:   <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>,
  msg:    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>,
  pin:    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14V7a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4z"/></svg>,
  cog:    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>,
  help:   <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>,
  send:   <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>,
  search: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>,
};

// ─── Toast notifications ───────────────────────────────────────────────────
function ToastContainer({ toasts, onDismiss }) {
  if (!toasts.length) return null;
  return (
    <div className="toast-container">
      {toasts.map(t => (
        <div key={t.id} className={`toast toast-${t.type}`}>
          <span className="toast-icon">
            {t.type === "error" ? "⚠" : t.type === "ok" ? "✓" : "ℹ"}
          </span>
          <span className="toast-msg">{t.message}</span>
          <button className="toast-close" onClick={() => onDismiss(t.id)}>×</button>
        </div>
      ))}
    </div>
  );
}

// ─── Copy button ──────────────────────────────────────────────────────────
function copyToClipboard(text) {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text);
  }
  // Fallback for http (non-HTTPS) contexts
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.cssText = "position:fixed;top:-999px;left:-999px;opacity:0";
  document.body.appendChild(ta);
  ta.select();
  document.execCommand("copy");
  document.body.removeChild(ta);
  return Promise.resolve();
}

function CopyButton({ text, className }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    copyToClipboard(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    }).catch(() => {});
  };
  return (
    <button className={className || "rich-copy-btn"} onClick={copy} title="Copy to clipboard">
      {copied ? "✓ Copied" : "Copy"}
    </button>
  );
}

// ─── Rich text renderer ────────────────────────────────────────────────────
function inlineRich(text) {
  const parts = (text || "").split(/(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g);
  return parts.map((p, i) => {
    if (p.startsWith("**") && p.endsWith("**")) return <strong key={i}>{p.slice(2, -2)}</strong>;
    if (p.startsWith("*")  && p.endsWith("*"))  return <em key={i}>{p.slice(1, -1)}</em>;
    if (p.startsWith("`")  && p.endsWith("`"))  return <code key={i}>{p.slice(1, -1)}</code>;
    return p;
  });
}

function renderRich(text) {
  if (!text) return null;
  const lines = text.split("\n");
  const out = [];
  let i = 0;
  let key = 0;

  const parseCells = row =>
    row.trim().replace(/^\||\|$/g, "").split("|").map(c => c.trim());
  const isSep = row => /^\s*\|[\s\-:|]+\|\s*$/.test(row);

  while (i < lines.length) {
    const line = lines[i];

    // Pipe table
    if (line.trim().startsWith("|")) {
      const tLines = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        tLines.push(lines[i]); i++;
      }
      const rows = tLines.filter(l => !isSep(l));
      if (rows.length > 0) {
        const [hRow, ...bRows] = rows;
        const tsvText = rows.map(r => parseCells(r).join("\t")).join("\n");
        out.push(
          <div key={key++} className="rich-block-wrap">
            <CopyButton text={tsvText} />
            <table className="msg-table">
              <thead><tr>{parseCells(hRow).map((h, j) => <th key={j}>{inlineRich(h)}</th>)}</tr></thead>
              <tbody>{bRows.map((r, ri) => (
                <tr key={ri}>{parseCells(r).map((c, j) => <td key={j}>{inlineRich(c)}</td>)}</tr>
              ))}</tbody>
            </table>
          </div>
        );
      }
      continue;
    }

    // Bullet list
    if (/^[-*•]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^[-*•]\s+/.test(lines[i]))
        items.push(lines[i++].replace(/^[-*•]\s+/, ""));
      out.push(<ul key={key++}>{items.map((it, j) => <li key={j}>{inlineRich(it)}</li>)}</ul>);
      continue;
    }

    // Numbered list
    if (/^\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i]))
        items.push(lines[i++].replace(/^\d+\.\s+/, ""));
      out.push(<ol key={key++}>{items.map((it, j) => <li key={j}>{inlineRich(it)}</li>)}</ol>);
      continue;
    }

    if (line.trim() === "") { i++; continue; }

    out.push(<p key={key++}>{inlineRich(line)}</p>);
    i++;
  }
  return out;
}

// ─── Extract MCP server from namespaced tool name ─────────────────────────
// Tool names are namespaced: "frontend__get_all_sessions" → "frontend"
function serverFromTool(toolName) {
  const parts = (toolName || "").split("__");
  return parts.length >= 2 ? parts[0] : null;
}

// ─── Tool call card ────────────────────────────────────────────────────────
function ToolCallCard({ tool, label, callId, state, durationMs, error, resultPreview, server }) {
  const svc = server || serverFromTool(tool) || "user";
  const port = (MCP_SERVERS.find(s => s.id === svc) || {}).port;

  return (
    <div className="tool-call" data-svc={svc}>
      <div className="tc-head">
        <div className="tc-ico">{svc[0].toUpperCase()}</div>
        <div className="tc-title">
          <b>{label || tool}</b>
          <span className="sub">
            mcp · <span className="svr">{svc}{port ? `@:${port}` : ""}</span> · tools/call
          </span>
        </div>
        <span className="tc-dur">{state === "done" && durationMs ? `${durationMs}ms` : ""}</span>
        <span className={`tc-status ${state}`}>
          {state === "running" && <span className="spin"></span>}
          {state !== "running" && <span className="blink"></span>}
          {state}
        </span>
      </div>

      <div className="tc-args">
        <span className="k">tool</span>
        <span className="v code">{tool}</span>
      </div>

      {state === "done" && resultPreview && (
        <div className="tc-result">
          <div className="tc-result-head">
            <span className="arrow">←</span> {error ? "Error" : "200 OK"}
            <span className="summary">{error ? error.slice(0, 80) : resultPreview.slice(0, 120)}</span>
          </div>
        </div>
      )}
      {state === "done" && error && !resultPreview && (
        <div className="tc-result">
          <div className="tc-result-head">
            <span className="arrow">←</span> Error
            <span className="summary" style={{color:"var(--hot)"}}>{error.slice(0, 100)}</span>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Session card ──────────────────────────────────────────────────────────
function SessionCard({ s }) {
  const cap = s.capacity != null ? `cap. ${s.capacity}` : null;
  return (
    <div className="record">
      <div className="r-main">
        <div className="r-title">{s.name || s.title}</div>
        <div className="r-meta">
          {s.date && <span>{s.date}</span>}
          {s.location && <span>{s.location}</span>}
          {cap && <span>{cap}</span>}
        </div>
      </div>
      <span className={`r-pill ${s.status === "active" ? "svc" : "ok"}`}>{s.status || "active"}</span>
    </div>
  );
}

// ─── Invoice card ──────────────────────────────────────────────────────────
function InvoiceCard({ inv }) {
  const sc = (inv.status || "").toLowerCase();
  return (
    <div className="inv-row">
      <span className="iid">{inv.invoice_id || inv.id || "—"}</span>
      <div className="who"><b>{inv.member_name || inv.who || inv.client || "—"}</b></div>
      <span className="amt">€{parseFloat(inv.amount || 0).toLocaleString("nl-BE", {minimumFractionDigits:2})}</span>
      <span className={`inv-pill ${sc}`}>{sc || "unknown"}</span>
    </div>
  );
}

// ─── Order card ────────────────────────────────────────────────────────────
function OrderCard({ o }) {
  return (
    <div className="inv-row">
      <span className="iid">#{o.order_id || o.id}</span>
      <div className="who"><b>{o.member || o.customer || "—"}</b></div>
      <span className="amt">€{parseFloat(o.total || o.amount || 0).toLocaleString("nl-BE", {minimumFractionDigits:2})}</span>
      <span className="inv-pill paid">{o.status || "paid"}</span>
    </div>
  );
}

// ─── Wallet card ───────────────────────────────────────────────────────────
function WalletCard({ w }) {
  const status = (w.Wallet_Status__c || w.wallet_status || w.status || "").toLowerCase();
  const isLeased = status === "leased";
  const balance = w.Wallet_Balance__c ?? w.wallet_balance ?? w.balance ?? null;
  const leaseId = w.Last_Lease_ID__c || w.last_lease_id || null;
  const masterUuid = w.master_uuid || w.Master_UUID__c || null;

  return (
    <div style={{ padding: "12px 14px", background: "var(--surface)", border: "1px solid var(--line)", borderRadius: "var(--r-md)", display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontWeight: 600, fontSize: 13 }}>Wallet</span>
        <span className={`inv-pill ${isLeased ? "pending" : "paid"}`}>{isLeased ? "Leased" : status || "Active"}</span>
        {isLeased && (
          <span style={{ fontSize: 11, color: "var(--warn)", fontFamily: "var(--font-mono)" }}>
            ⚠ Kassa holds live balance
          </span>
        )}
      </div>
      {balance !== null && (
        <div style={{ fontSize: 18, fontWeight: 700, fontFamily: "var(--font-mono)" }}>
          €{parseFloat(balance).toLocaleString("nl-BE", { minimumFractionDigits: 2 })}
          {isLeased && (
            <span style={{ fontSize: 11, fontWeight: 400, color: "var(--muted)", marginLeft: 6 }}>
              (CRM cached — niet actueel)
            </span>
          )}
        </div>
      )}
      {masterUuid && (
        <div style={{ fontSize: 11, color: "var(--muted-2)", fontFamily: "var(--font-mono)" }}>{masterUuid}</div>
      )}
      {leaseId && (
        <div style={{ fontSize: 11, color: "var(--muted-2)", fontFamily: "var(--font-mono)" }}>
          Lease: {leaseId}
        </div>
      )}
    </div>
  );
}

// ─── Service status grid ───────────────────────────────────────────────────
function ServiceStatusGrid({ services }) {
  return (
    <div className="svc-grid">
      {services.map((s, i) => (
        <div key={i} className={`svc-tile ${s.status || "unknown"}`}>
          <span className={`dot ${s.status || "unknown"}`}></span>
          <span className="name">{s.service || s.name}</span>
          <span className="status">{s.status || "unknown"}</span>
        </div>
      ))}
    </div>
  );
}

// ─── Cards renderer — interprets `cards` events from agent ───────────────
function CardsArea({ cardEvents }) {
  if (!cardEvents || cardEvents.length === 0) return null;
  return (
    <div style={{marginTop: 10, display:"flex", flexDirection:"column", gap: 6}}>
      {cardEvents.map((ev, idx) => {
        const { card_type, data } = ev;
        if (card_type === "session" && Array.isArray(data)) {
          return (
            <div key={idx} className="tc-cards">
              {data.map((s, i) => <SessionCard key={i} s={s} />)}
            </div>
          );
        }
        if (card_type === "invoice" && Array.isArray(data)) {
          return <div key={idx} className="inv-list">{data.map((inv, i) => <InvoiceCard key={i} inv={inv} />)}</div>;
        }
        if (card_type === "invoice_total") {
          return (
            <div key={idx} className="rev-hero" style={{background:"var(--primary)"}}>
              <div>
                <div className="rev-hero-label">{data.count} invoice{data.count !== 1 ? "s" : ""}</div>
                <div className="rev-hero-amount">
                  <span className="cur">€</span>{parseFloat(data.total_amount||0).toLocaleString("nl-BE",{minimumFractionDigits:2})}
                  <span className="sub">{data.currency || "EUR"}</span>
                </div>
              </div>
            </div>
          );
        }
        if (card_type === "service_status" && Array.isArray(data)) {
          return <ServiceStatusGrid key={idx} services={data} />;
        }
        if (card_type === "error_log" && Array.isArray(data)) {
          return (
            <div key={idx} style={{display:"flex",flexDirection:"column",gap:4,marginTop:4}}>
              {data.map((e, i) => {
                const lvl = (e.level||"").toLowerCase();
                return (
                  <div key={i} className={`log-line ${lvl}`} style={{fontFamily:"var(--font-mono)",fontSize:11,padding:"6px 10px",borderRadius:6,borderLeft:`3px solid ${lvl==="error"?"var(--hot)":lvl==="warning"?"var(--warn)":"var(--line-2)"}`,background:lvl==="error"?"var(--hot-soft)":lvl==="warning"?"var(--warn-soft)":"var(--surface-2)"}}>
                    <b style={{marginRight:6}}>{e.source||"?"}</b>{e.message}
                    {e["@timestamp"] && <span style={{opacity:.5,float:"right"}}>{new Date(e["@timestamp"]).toLocaleTimeString()}</span>}
                  </div>
                );
              })}
            </div>
          );
        }
        if (card_type === "member" && Array.isArray(data)) {
          return (
            <div key={idx} style={{display:"flex",flexDirection:"column",gap:6}}>
              {data.map((m, i) => (
                <div key={i} style={{padding:"10px 13px",background:"var(--surface)",border:"1px solid var(--line)",borderRadius:"var(--r-md)",fontSize:13}}>
                  <div style={{fontWeight:600,marginBottom:4}}>{m.name||m.email}</div>
                  <div style={{color:"var(--muted)",fontSize:12}}>✉ {m.email}{m.registration_status&&<span style={{marginLeft:8,padding:"1px 8px",borderRadius:99,background:"var(--primary-soft)",color:"var(--primary)",fontSize:10,fontWeight:600}}>{m.registration_status}</span>}</div>
                </div>
              ))}
            </div>
          );
        }
        if (card_type === "order" && Array.isArray(data)) {
          return <div key={idx} className="inv-list">{data.map((o, i) => <OrderCard key={i} o={o} />)}</div>;
        }
        if (card_type === "wallet") {
          const items = Array.isArray(data) ? data : [data];
          return (
            <div key={idx} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {items.map((w, i) => <WalletCard key={i} w={w} />)}
            </div>
          );
        }
        return null;
      })}
    </div>
  );
}

// ─── Message components ────────────────────────────────────────────────────
function UserMessage({ text, email, ts }) {
  const initials = (email || "AD").split("@")[0].slice(0,2).toUpperCase();
  const time = ts ? new Date(ts).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"}) : "";
  return (
    <div className="msg user">
      <div className="msg-av user">{initials}</div>
      <div className="msg-body">
        <div className="msg-meta">
          <b>{email || "Admin"}</b>
          {time && <span>· {time}</span>}
        </div>
        <div className="msg-text">{renderRich(text)}</div>
      </div>
    </div>
  );
}

function AssistantMessage({ text, streaming, cursor, cardEvents, suggestions, onSuggest, ts }) {
  const time = ts ? new Date(ts).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"}) : "";
  return (
    <div className="msg assist">
      <div className="msg-av assist">AI</div>
      <div className="msg-body">
        <div className="msg-meta">
          <b>Admin Assistant</b>
          <span className="who-tag">llama-3.3-70b-instruct</span>
          {time && <span>· {time}</span>}
          {!streaming && text && <CopyButton text={text} className="msg-copy-btn" />}
        </div>
        <div className="msg-text">
          {renderRich(text)}
          {streaming && <span className="cursor-blink"></span>}
        </div>
        <CardsArea cardEvents={cardEvents} />
        {suggestions && suggestions.length > 0 && (
          <div className="chips">
            {suggestions.map((s, i) => (
              <button key={i} className="chip" onClick={() => onSuggest && onSuggest(s)}>{s}</button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ThinkingBubble({ label }) {
  return (
    <div className="msg assist">
      <div className="msg-av assist">AI</div>
      <div className="msg-body">
        <div className="msg-meta"><b>Admin Assistant</b><span className="thinking-label">{label || "thinking…"}</span></div>
        <div className="typing"><span className="d"></span><span className="d"></span><span className="d"></span></div>
      </div>
    </div>
  );
}

function ToolBundle({ tools }) {
  return (
    <div className="msg assist">
      <div className="msg-av assist">AI</div>
      <div className="msg-body">
        <div className="msg-meta">
          <b>Admin Assistant</b>
          <span className="thinking-label">
            running {tools.length} tool{tools.length === 1 ? "" : "s"} in parallel
          </span>
        </div>
        {tools.map((t) => (
          <ToolCallCard key={t.callId}
            tool={t.tool} label={t.label} callId={t.callId}
            state={t.state} durationMs={t.durationMs}
            error={t.error} resultPreview={t.resultPreview}
            server={t.server}
          />
        ))}
      </div>
    </div>
  );
}

function ErrorToast({ message }) {
  return (
    <div className="msg assist">
      <div className="msg-av assist" style={{background:"var(--hot-soft)",color:"var(--hot)"}}>!</div>
      <div className="msg-body">
        <div className="msg-meta"><b style={{color:"var(--hot)"}}>Error</b></div>
        <div className="msg-text" style={{color:"var(--hot)",background:"var(--hot-soft)",padding:"8px 12px",borderRadius:8,fontSize:13}}>{message}</div>
      </div>
    </div>
  );
}

function ConfirmCard({ tool, label, args }) {
  const argLines = Object.entries(args || {}).filter(([, v]) => v !== undefined && v !== null);
  return (
    <div className="msg assist">
      <div className="msg-av assist" style={{background:"var(--warn-soft, #FEF3C7)",color:"var(--warn, #D97706)"}}>⚠</div>
      <div className="msg-body">
        <div className="msg-meta">
          <b style={{color:"var(--warn, #D97706)"}}>Bevestiging vereist</b>
        </div>
        <div className="confirm-card">
          <div className="confirm-op">
            <span className="confirm-icon">🔒</span>
            <span className="confirm-tool">{label}</span>
          </div>
          {argLines.length > 0 && (
            <div className="confirm-args">
              {argLines.map(([k, v]) => (
                <div key={k} className="confirm-arg-row">
                  <span className="confirm-arg-k">{k.replace(/_/g, " ")}</span>
                  <span className="confirm-arg-v">{String(v).slice(0, 80)}</span>
                </div>
              ))}
            </div>
          )}
          <div className="confirm-hint">Type <b>ja</b> om te bevestigen of <b>nee</b> om te annuleren.</div>
        </div>
      </div>
    </div>
  );
}

// ─── Dashboard KPI strip ───────────────────────────────────────────────────
function DashboardStrip({ kpis, onOpenMonitoring }) {
  if (!kpis) return null;
  const { services_online: on, services_degraded: deg, services_offline: off, active_alerts: alerts } = kpis;
  const items = [
    { v: on,     l: "Online",   c: "ok",     clickable: true  },
    { v: deg,    l: "Degraded", c: deg  > 0 ? "warn"   : "muted-2", clickable: deg  > 0 },
    { v: off,    l: "Offline",  c: off  > 0 ? "hot"    : "muted-2", clickable: off  > 0 },
    { v: alerts, l: "Alerts",   c: alerts > 0 ? "hot"  : "muted-2", clickable: alerts > 0 },
  ];
  return (
    <div style={{
      display: "flex", gap: 0, borderBottom: "1px solid var(--line)",
      background: "var(--surface)", flexShrink: 0,
    }}>
      {items.map(({ v, l, c, clickable }) => (
        <button
          key={l}
          onClick={clickable ? onOpenMonitoring : undefined}
          title={clickable ? "Open Monitoring panel" : undefined}
          style={{
            display: "flex", alignItems: "center", gap: 8, padding: "9px 16px 11px",
            borderRight: "1px solid var(--line)", fontSize: 12,
            background: "none", border: "none", borderRight: "1px solid var(--line)",
            cursor: clickable ? "pointer" : "default",
            transition: "background .15s",
          }}
          onMouseEnter={e => { if (clickable) e.currentTarget.style.background = "var(--surface-2)"; }}
          onMouseLeave={e => { e.currentTarget.style.background = "none"; }}
        >
          <span style={{ fontWeight: 700, fontFamily: "var(--font-mono)", color: `var(--${c})` }}>{v ?? "—"}</span>
          <span style={{ color: "var(--muted)", fontSize: 11 }}>{l}</span>
        </button>
      ))}
      <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", padding: "0 14px", fontSize: 10, color: "var(--muted-2)", fontFamily: "var(--font-mono)" }}>
        monitoring MCP · live
      </div>
    </div>
  );
}

// ─── Settings (localStorage-backed, replaces TweaksPanel) ─────────────────
const SETTINGS_KEY = "shift_admin_settings";
const SETTINGS_DEFAULTS = { theme: "light", accent: "navy", density: "comfy", showBundle: false };
const ACCENT_MAP = {
  navy:   { c: "#1F3A8A", dk: "#172A63", soft: "#EEF1F9", line: "#D7DEF0" },
  teal:   { c: "#0E7C66", dk: "#0A5C4D", soft: "#E6F4F1", line: "#BCDED5" },
  purple: { c: "#7C3AED", dk: "#5B21B6", soft: "#F0EBFB", line: "#D9C7F4" },
  slate:  { c: "#334155", dk: "#1E293B", soft: "#EFF1F5", line: "#D2D7E0" },
};

function loadSettings() {
  try { return { ...SETTINGS_DEFAULTS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") }; }
  catch { return { ...SETTINGS_DEFAULTS }; }
}
function persistSettings(s) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch {}
}

function SettingsModal({ settings, onChange, onClose }) {
  const THEMES = ["light", "dark", "slate", "sepia", "contrast"];
  const ACCENTS = [
    { id: "navy",   hex: "#1F3A8A", label: "Navy"   },
    { id: "teal",   hex: "#0E7C66", label: "Teal"   },
    { id: "purple", hex: "#7C3AED", label: "Purple" },
    { id: "slate",  hex: "#334155", label: "Slate"  },
  ];
  const DENSITIES = ["cozy", "comfy", "loose"];

  const row = { marginBottom: 22 };
  const lbl = { fontSize: 11, fontWeight: 600, color: "var(--muted)", textTransform: "uppercase", letterSpacing: ".07em", marginBottom: 10, display: "block" };
  const pill = (active) => ({
    padding: "5px 13px", borderRadius: 8, fontSize: 12, cursor: "pointer", fontFamily: "var(--font)",
    border: `1.5px solid ${active ? "var(--primary)" : "var(--line)"}`,
    background: active ? "var(--primary-soft)" : "var(--surface-2)",
    color: active ? "var(--primary)" : "var(--muted)",
    fontWeight: active ? 600 : 400,
  });

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.45)", zIndex: 900, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div onClick={e => e.stopPropagation()} style={{ background: "var(--surface)", border: "1px solid var(--line)", borderRadius: 18, padding: "28px 28px 24px", width: 380, boxShadow: "var(--shadow-lg)" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 26 }}>
          <h2 style={{ fontSize: 16, fontWeight: 700, margin: 0 }}>Settings</h2>
          <button onClick={onClose} style={{ background: "none", border: "none", fontSize: 18, cursor: "pointer", color: "var(--muted)", lineHeight: 1, padding: "2px 6px", borderRadius: 6 }}>×</button>
        </div>

        <div style={row}>
          <span style={lbl}>Color theme</span>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {THEMES.map(t => (
              <button key={t} style={pill(settings.theme === t)} onClick={() => onChange("theme", t)}>{t}</button>
            ))}
          </div>
        </div>

        <div style={row}>
          <span style={lbl}>Accent color</span>
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            {ACCENTS.map(a => (
              <button key={a.id} title={a.label} onClick={() => onChange("accent", a.id)} style={{
                width: 30, height: 30, borderRadius: 8, background: a.hex, cursor: "pointer",
                border: `2.5px solid ${settings.accent === a.id ? "var(--ink)" : "transparent"}`,
                boxShadow: settings.accent === a.id ? `0 0 0 1.5px var(--surface), 0 0 0 3px ${a.hex}` : "none",
                transition: "box-shadow .15s",
              }} />
            ))}
          </div>
        </div>

        <div style={row}>
          <span style={lbl}>Density</span>
          <div style={{ display: "flex", gap: 6 }}>
            {DENSITIES.map(d => (
              <button key={d} style={{ ...pill(settings.density === d), flex: 1 }} onClick={() => onChange("density", d)}>{d}</button>
            ))}
          </div>
        </div>

        <div style={{ ...row, marginBottom: 0, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <div>
            <span style={{ ...lbl, marginBottom: 4 }}>Show tool call output</span>
            <div style={{ fontSize: 11, color: "var(--muted-2)", lineHeight: 1.4 }}>
              Display raw JSON returned by MCP tools in the chat.
            </div>
          </div>
          <button
            onClick={() => onChange("showBundle", !settings.showBundle)}
            style={{
              width: 38, height: 22, borderRadius: 11, border: "none", cursor: "pointer", padding: 0, flexShrink: 0,
              background: settings.showBundle ? "var(--primary)" : "var(--line)",
              position: "relative", transition: "background .15s",
            }}
            aria-pressed={settings.showBundle}
          >
            <span style={{
              position: "absolute", top: 2, left: settings.showBundle ? 18 : 2,
              width: 18, height: 18, borderRadius: "50%", background: "var(--surface)",
              boxShadow: "0 1px 3px rgba(0,0,0,.2)", transition: "left .15s",
            }} />
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Login screen ──────────────────────────────────────────────────────────
function LoginScreen({ onLogin, skipAutoLogin = false }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  // On mount: check if a valid session cookie exists → skip login entirely.
  // Skipped when skipAutoLogin is set (e.g. right after logout).
  useEffect(() => {
    if (skipAutoLogin) { setLoading(false); return; }
    fetch("/api/me")
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data && data.identity_uuid) {
          sessionStorage.setItem("admin_identity", JSON.stringify(data));
          onLogin(data);
        } else {
          setLoading(false);
        }
      })
      .catch(() => setLoading(false));
  }, [onLogin, skipAutoLogin]);

  const doLogin = async () => {
    const em = email.trim().toLowerCase();
    if (!em) { setError("Vul je e-mailadres in."); return; }
    setLoading(true); setError("");
    try {
      const res = await fetch("/api/identify", {
        method: "POST", headers: {"Content-Type":"application/json"},
        body: JSON.stringify({ email: em, password })
      });
      const data = await res.json();
      if (!res.ok || data.error) { setError(data.error || "Ongeldig e-mailadres of wachtwoord."); return; }
      sessionStorage.setItem("admin_identity", JSON.stringify(data));
      onLogin(data);
    } catch {
      setError("Server niet bereikbaar.");
    } finally {
      setLoading(false);
    }
  };

  const inputStyle = {width:"100%",padding:"10px 13px",background:"var(--surface)",border:"1px solid var(--line)",borderRadius:8,color:"var(--ink)",fontSize:14,fontFamily:"var(--font)",outline:"none",boxSizing:"border-box"};

  if (loading) return (
    <div style={{position:"fixed",inset:0,display:"flex",alignItems:"center",justifyContent:"center",background:"var(--bg)"}}>
      <div style={{fontFamily:"var(--font-mono)",fontSize:12,color:"var(--muted-2)"}}>Sessie controleren…</div>
    </div>
  );

  return (
    <div className="login-wrap" style={{position:"fixed",inset:0,display:"flex",alignItems:"center",justifyContent:"center",background:"var(--bg)"}}>
      <div style={{width:"100%",maxWidth:420,padding:"24px"}}>
        <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:32,justifyContent:"center"}}>
          <div style={{width:40,height:40,borderRadius:10,background:"linear-gradient(160deg, var(--primary), var(--ink-2))",display:"flex",alignItems:"center",justifyContent:"center",boxShadow:"0 4px 12px rgba(31,58,138,.35)"}}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="white"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/></svg>
          </div>
          <span style={{fontSize:18,fontWeight:700,letterSpacing:"-.015em"}}>Shift Festival</span>
          <span style={{fontSize:10,fontWeight:600,letterSpacing:".08em",textTransform:"uppercase",padding:"2px 8px",borderRadius:99,background:"var(--primary-soft)",color:"var(--primary)",border:"1px solid rgba(31,58,138,.15)"}}>Admin</span>
        </div>

        <div className="login-card" style={{background:"var(--surface)",border:"1px solid var(--line)",borderRadius:18,padding:"36px 32px",boxShadow:"var(--shadow-lg)"}}>
          <div style={{fontSize:20,fontWeight:700,marginBottom:4,letterSpacing:"-.01em"}}>Aanmelden</div>
          <div style={{fontSize:13,color:"var(--muted)",marginBottom:28,lineHeight:1.5}}>
            Vul je werkmail en wachtwoord in.
          </div>

          <div style={{marginBottom:14}}>
            <label style={{display:"block",fontSize:11,fontWeight:600,color:"var(--muted)",marginBottom:6,letterSpacing:".06em",textTransform:"uppercase"}}>E-mail</label>
            <input
              type="email" value={email} placeholder="jij@shiftfestival.be"
              onChange={e => setEmail(e.target.value)}
              onKeyDown={e => e.key === "Enter" && document.getElementById("pw-field")?.focus()}
              style={inputStyle}
              autoFocus
            />
          </div>

          <div style={{marginBottom:20}}>
            <label style={{display:"block",fontSize:11,fontWeight:600,color:"var(--muted)",marginBottom:6,letterSpacing:".06em",textTransform:"uppercase"}}>Wachtwoord</label>
            <input
              id="pw-field"
              type="password" value={password} placeholder="••••••••"
              onChange={e => setPassword(e.target.value)}
              onKeyDown={e => e.key === "Enter" && doLogin()}
              style={inputStyle}
            />
          </div>

          {error && (
            <div style={{fontSize:12,color:"var(--hot)",marginBottom:14,background:"var(--hot-soft)",border:"1px solid rgba(214,58,74,.15)",borderRadius:8,padding:"8px 12px"}}>
              {error}
            </div>
          )}

          <button
            onClick={doLogin} disabled={loading}
            style={{width:"100%",padding:"11px 16px",background:"var(--primary)",border:"none",borderRadius:8,color:"#fff",fontSize:14,fontWeight:600,fontFamily:"var(--font)",cursor:loading?"not-allowed":"pointer",opacity:loading?0.5:1,display:"flex",alignItems:"center",justifyContent:"center",gap:8}}
          >
            {loading ? "Bezig…" : "Aanmelden →"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Sidebar ───────────────────────────────────────────────────────────────
function Sidebar({ history, activeConvId, onPick, onNew, onPin, onDelete, mode, setMode }) {
  const pinned = history.filter(h => h.pinned);
  const recent = history.filter(h => !h.pinned);

  return (
    <nav className="sidebar">
      <div className="sb-mode">
        <button className={`sb-mode-btn ${mode === "agent" ? "is-active" : ""}`} onClick={() => setMode("agent")}>
          <span className="pip"></span>Agent
        </button>
        <button className={`sb-mode-btn ${mode === "logs" ? "is-active" : ""}`} onClick={() => setMode("logs")}>
          <span className="pip"></span>Live logs
        </button>
        <button className={`sb-mode-btn ${mode === "msgflow" ? "is-active" : ""}`} onClick={() => setMode("msgflow")}>
          <span className="pip"></span>Berichtenflow
        </button>
      </div>

      <button className="sb-new" onClick={onNew}>
        <span className="plus">{I.plus}</span>
        New conversation
        <span className="kbd">⌘N</span>
      </button>

      {pinned.length > 0 && (
        <div className="sb-section">
          <div className="sb-label">Pinned</div>
          {pinned.map(h => (
            <SidebarItem key={h.id} h={h} activeConvId={activeConvId} onPick={onPick} onPin={onPin} onDelete={onDelete} />
          ))}
        </div>
      )}

      <div className="sb-section">
        <div className="sb-label">Recent</div>
        {recent.length === 0 && (
          <div style={{ padding: "6px 14px", fontSize: 11, color: "var(--muted-2)" }}>No conversations yet.</div>
        )}
        {recent.map(h => (
          <SidebarItem key={h.id} h={h} activeConvId={activeConvId} onPick={onPick} onPin={onPin} onDelete={onDelete} />
        ))}
      </div>

      <div className="sb-spacer"></div>
      <div className="sb-tip">
        <b>Tip — keyboard</b>
        <span className="kbd">/</span> to focus the composer · <span className="kbd">⌘N</span> for new chat
      </div>
    </nav>
  );
}

function SidebarItem({ h, activeConvId, onPick, onPin, onDelete }) {
  const [hover, setHover] = React.useState(false);

  const handleDelete = (e) => {
    e.stopPropagation();
    onDelete(h.id);
  };

  return (
    <div className={`sb-item ${h.id === activeConvId ? "is-active" : ""}`}
      style={{ position: "relative", display: "flex", alignItems: "center" }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <button
        style={{ flex: 1, display: "flex", alignItems: "center", gap: 6, background: "none", border: "none", cursor: "pointer", color: "inherit", fontFamily: "inherit", textAlign: "left", padding: 0, minWidth: 0 }}
        onClick={() => onPick(h.id)}
        title={h.label}
      >
        <span className="ic">{h.pinned ? I.pin : I.msg}</span>
        <span className="label" style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{h.label}</span>
        <span className="time">{h.time}</span>
      </button>
      <div style={{ position: "absolute", right: 4, display: "flex", gap: 3, opacity: hover ? 1 : 0, transition: "opacity .15s", pointerEvents: hover ? "auto" : "none" }}>
        <button
          onClick={e => { e.stopPropagation(); onPin(h.id); }}
          title={h.pinned ? "Unpin" : "Pin"}
          style={{
            background: "var(--surface-2)", border: "1px solid var(--line)",
            borderRadius: 5, width: 20, height: 20, display: "flex", alignItems: "center", justifyContent: "center",
            cursor: "pointer", color: h.pinned ? "var(--primary)" : "var(--muted-2)", flexShrink: 0,
          }}
        >
          {I.pin}
        </button>
        <button
          onClick={handleDelete}
          title="Delete"
          style={{
            background: "var(--surface-2)", border: "1px solid var(--line)",
            borderRadius: 5, width: 20, height: 20, display: "flex", alignItems: "center", justifyContent: "center",
            cursor: "pointer", color: "var(--muted-2)", flexShrink: 0,
            transition: "background .15s, border-color .15s, color .15s",
          }}
          onMouseEnter={e => { e.currentTarget.style.background = "rgba(239,68,68,.15)"; e.currentTarget.style.color = "#f87171"; e.currentTarget.style.borderColor = "rgba(239,68,68,.5)"; }}
          onMouseLeave={e => { e.currentTarget.style.background = "var(--surface-2)"; e.currentTarget.style.color = "var(--muted-2)"; e.currentTarget.style.borderColor = "var(--line)"; }}
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/>
          </svg>
        </button>
      </div>
    </div>
  );
}

// ─── Topbar ────────────────────────────────────────────────────────────────
function Topbar({ identity, connected, serverCount, onSettings, sidebarOpen, onToggleSidebar, flowOpen, onToggleFlow, onLogout }) {
  const initials = identity ? (identity.email || "AD").split("@")[0].slice(0,2).toUpperCase() : "??";
  return (
    <header className="topbar">
      <button
        className="icon-btn"
        title={sidebarOpen ? "Hide conversations" : "Show conversations"}
        onClick={onToggleSidebar}
        style={{ opacity: sidebarOpen ? 1 : 0.55 }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <line x1="9" y1="4" x2="9" y2="20" />
        </svg>
      </button>
      <div className="brand">
        <div className="brand-mark">SF</div>
        <span className="brand-name">Shift Festival</span>
        <span className="brand-tag">Admin</span>
      </div>
      <div className="topbar-spacer"></div>
      <span className={`conn-pill ${connected ? "online" : "offline"}`}>
        <span className="dot"></span>
        <span className="label">{connected ? "Online" : "Reconnecting…"}</span>
        {connected && <span style={{color:"var(--muted-2)"}}>· /ws · {serverCount} MCP servers</span>}
      </span>
      <button
        className="icon-btn"
        title={flowOpen ? "Hide MCP topology" : "Show MCP topology"}
        onClick={onToggleFlow}
        style={{ opacity: flowOpen ? 1 : 0.55 }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <line x1="15" y1="4" x2="15" y2="20" />
        </svg>
      </button>
      <button className="icon-btn" title="Settings" onClick={onSettings}>{I.cog}</button>
      <div className="user-chip">
        <span className="av">{initials}</span>
        <span className="em">{identity ? identity.email : "…"}</span>
        <span className="role">admin</span>
      </div>
      <button className="icon-btn topbar-logout" title="Uitloggen" onClick={onLogout}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
          <polyline points="16 17 21 12 16 7"/>
          <line x1="21" y1="12" x2="9" y2="12"/>
        </svg>
      </button>
    </header>
  );
}

// ─── Slash commands ───────────────────────────────────────────────────────
const SLASH_COMMANDS = [
  { cmd: "/delete",  hint: "Delete a session or user account",         fill: "/delete "  },
  { cmd: "/block",   hint: "Block a user from the platform",           fill: "/block "   },
  { cmd: "/unblock", hint: "Unblock a previously blocked user",        fill: "/unblock " },
  { cmd: "/refund",  hint: "Refund an invoice or order",               fill: "/refund "  },
  { cmd: "/status",  hint: "Check service health and MCP connectivity",fill: "/status"   },
  { cmd: "/enroll",  hint: "Enroll a user in a session",               fill: "/enroll "  },
  { cmd: "/cancel",  hint: "Cancel an enrollment or booking",          fill: "/cancel "  },
  { cmd: "/lookup",  hint: "Look up a user by email or UUID",          fill: "/lookup "  },
];

// ─── Composer ──────────────────────────────────────────────────────────────
function Composer({ onSend, busy, disabled }) {
  const [draft, setDraft] = useState("");
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashIdx, setSlashIdx] = useState(0);
  const taRef = useRef(null);

  const slashMatches = useMemo(() => {
    if (!draft.startsWith("/")) return [];
    const q = draft.toLowerCase();
    return SLASH_COMMANDS.filter(c => c.cmd.startsWith(q));
  }, [draft]);

  useEffect(() => {
    setSlashOpen(slashMatches.length > 0 && draft !== slashMatches[0]?.fill?.trimEnd());
    setSlashIdx(0);
  }, [slashMatches.length, draft]);

  const selectSlash = (item) => {
    setDraft(item.fill);
    setSlashOpen(false);
    taRef.current?.focus();
  };

  const submit = () => {
    if (draft.trim() && !busy && !disabled) {
      onSend(draft.trim());
      setDraft("");
      setSlashOpen(false);
    }
  };

  useEffect(() => {
    if (!taRef.current) return;
    taRef.current.style.height = "auto";
    taRef.current.style.height = Math.min(taRef.current.scrollHeight, 200) + "px";
  }, [draft]);

  const handleKeyDown = (e) => {
    if (slashOpen) {
      if (e.key === "ArrowDown")  { e.preventDefault(); setSlashIdx(i => Math.min(i + 1, slashMatches.length - 1)); return; }
      if (e.key === "ArrowUp")    { e.preventDefault(); setSlashIdx(i => Math.max(i - 1, 0)); return; }
      if (e.key === "Tab" || e.key === "Enter") { e.preventDefault(); selectSlash(slashMatches[slashIdx]); return; }
      if (e.key === "Escape")     { setSlashOpen(false); return; }
    }
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
  };

  return (
    <div className="composer">
      {slashOpen && (
        <div className="slash-menu">
          {slashMatches.map((item, i) => (
            <button
              key={item.cmd}
              className={`slash-item${i === slashIdx ? " is-active" : ""}`}
              onMouseDown={e => { e.preventDefault(); selectSlash(item); }}
            >
              <span className="slash-cmd">{item.cmd}</span>
              <span className="slash-hint">{item.hint}</span>
            </button>
          ))}
        </div>
      )}
      <div className="composer-inner">
        <textarea
          ref={taRef} rows="1"
          placeholder={disabled ? "Connecting to server…" : "Ask about sessions, invoices, members… or type / for commands"}
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={busy || disabled}
        />
        <button className="send-btn" onClick={submit} disabled={busy || disabled || !draft.trim()} aria-label="Send">
          {I.send}
        </button>
      </div>
      <div className="composer-hint">
        Press <span className="kbd">↵</span> to send · <span className="kbd">⇧↵</span> for newline · <span className="kbd">/</span> for commands
      </div>
    </div>
  );
}

// ─── Main App ──────────────────────────────────────────────────────────────
function App() {
  const [identity, setIdentity] = useState(() => {
    try { return JSON.parse(sessionStorage.getItem("admin_identity") || "null"); } catch { return null; }
  });
  const [justLoggedOut, setJustLoggedOut] = useState(false);
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [isThinking, setIsThinking] = useState(false);

  // Chat history — array of message objects
  const [messages, setMessages] = useState([]);

  // In-flight assistant state (streaming)
  const streamRef = useRef({ text: "", cards: [], msgId: null, awaitingResponse: false });
  const toolBundleRef = useRef(null); // current tool bundle msgId

  // Flow graph state
  const [activeNodes, setActiveNodes] = useState(new Set());
  const [doneNodes, setDoneNodes] = useState(new Set());
  const [activeEdges, setActiveEdges] = useState(new Set());
  // Lit state — paths that stay highlighted until the next question
  const [litNodes, setLitNodes] = useState(new Set());
  const [litEdges, setLitEdges] = useState(new Set());

  // Event log
  const [log, setLog] = useState([]);
  const [stats, setStats] = useState({ tools: 0, ok: 0, warn: 0, tokens: 0 });

  // ─── Dashboard KPIs ───────────────────────────────────────────────────────
  const [dashKpis, setDashKpis] = useState(null);
  useEffect(() => {
    const load = () => fetch("/api/dashboard/summary").then(r => r.json()).then(setDashKpis).catch(() => {});
    load();
    const id = setInterval(load, 60000);
    return () => clearInterval(id);
  }, []);

  // Live MCP server count
  const [mcpServerCount, setMcpServerCount] = useState(MCP_SERVERS.length);
  useEffect(() => {
    fetch("/api/mcp/tools")
      .then(r => r.json())
      .then(d => { if ((d.servers || []).length) setMcpServerCount(d.servers.length); })
      .catch(() => {});
  }, []);

  // ─── Toast notifications ──────────────────────────────────────────────────
  const [toasts, setToasts] = useState([]);
  const addToast = useCallback((message, type = "info") => {
    const id = Date.now() + Math.random();
    setToasts(ts => [...ts, { id, message, type }]);
    setTimeout(() => setToasts(ts => ts.filter(t => t.id !== id)), 5000);
  }, []);
  const dismissToast = useCallback((id) => setToasts(ts => ts.filter(t => t.id !== id)), []);

  // Background service status watcher — fires a toast when a service changes state
  const prevSvcStatus = useRef({});
  useEffect(() => {
    const poll = setInterval(() => {
      fetch("/api/monitoring/status")
        .then(r => r.json())
        .then(d => {
          const seen = new Set();
          (d.services || []).forEach(svc => {
            const id = svc.service;
            const live = Boolean(svc.live);
            seen.add(id);
            const prev = prevSvcStatus.current[id];
            if (prev !== undefined && prev !== live) {
              addToast(
                live ? `${id} is back online` : `${id} went offline`,
                live ? "ok" : "error"
              );
            }
            prevSvcStatus.current[id] = live;
          });
          // Remove stale entries for services no longer reported
          Object.keys(prevSvcStatus.current).forEach(id => {
            if (!seen.has(id)) delete prevSvcStatus.current[id];
          });
        })
        .catch(() => {});
    }, 5000);
    return () => clearInterval(poll);
  }, [addToast]);

  // Sidebar / UI state
  const [flowTab, setFlowTab] = useState("graph");
  const [mode, setMode] = useState("agent");
  const [logLevelFilter, setLogLevelFilter] = useState("any");
  const [logQuery, setLogQuery] = useState("");

  // ─── Settings (localStorage-backed) ──────────────────────────────────────
  const [settings, setSettings] = useState(loadSettings);
  const [showSettings, setShowSettings] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [flowOpen, setFlowOpen] = useState(true);

  const changeSetting = useCallback((key, val) => {
    setSettings(s => {
      const next = { ...s, [key]: val };
      persistSettings(next);
      return next;
    });
  }, []);

  useEffect(() => { document.body.dataset.theme = settings.theme; }, [settings.theme]);
  useEffect(() => { document.body.dataset.density = settings.density; }, [settings.density]);
  useEffect(() => {
    const c = ACCENT_MAP[settings.accent] || ACCENT_MAP.navy;
    const r = document.body.style;
    r.setProperty("--primary", c.c); r.setProperty("--primary-dk", c.dk);
    r.setProperty("--primary-soft", c.soft); r.setProperty("--primary-line", c.line);
  }, [settings.accent, settings.theme]);

  const messagesRef = useRef(null);
  useEffect(() => {
    const m = messagesRef.current;
    if (!m) return;
    let r1, r2;
    r1 = requestAnimationFrame(() => { r2 = requestAnimationFrame(() => { m.scrollTop = m.scrollHeight; }); });
    return () => { cancelAnimationFrame(r1); cancelAnimationFrame(r2); };
  }, [messages]);

  const pushLog = useCallback((e) => {
    const time = new Date().toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
    setLog(l => [...l.slice(-99), { id: Date.now() + Math.random(), time, ...e }]);
  }, []);

  const activateServer = useCallback((toolName) => {
    const svc = serverFromTool(toolName);
    const flow = svc && SERVER_FLOW[svc];
    const nodes = flow ? flow.nodes : ["user", "llama"];
    const edges = flow ? flow.edges : ["user->llama"];
    setActiveNodes(new Set(nodes));
    setActiveEdges(new Set(edges));
    setLitNodes(prev => new Set([...prev, ...nodes]));
    setLitEdges(prev => new Set([...prev, ...edges]));
    return svc;
  }, []);

  const clearActive = useCallback(() => {
    setActiveNodes(new Set());
    setActiveEdges(new Set());
  }, []);

  // ─── WebSocket ────────────────────────────────────────────────────────
  const wsRef = useRef(null);
  const sessionId = useRef((crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36)));

  const initWS = useCallback((uuid) => {
    if (wsRef.current && wsRef.current.readyState < 2) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws/${sessionId.current}`);
    wsRef.current = ws;

    ws.onopen = () => ws.send(JSON.stringify({ type: "identify", identity_uuid: uuid }));

    ws.onclose = () => {
      setConnected(false);
      setTimeout(() => { if (identity) initWS(identity.identity_uuid); }, 3000);
    };
    ws.onerror = () => setConnected(false);

    ws.onmessage = (e) => {
      try { handleEvent(JSON.parse(e.data)); } catch {}
    };
  }, [identity]);

  // ─── WebSocket event handler ──────────────────────────────────────────
  const handleEvent = useCallback((ev) => {
    switch (ev.type) {
      case "ready":
        setConnected(true);
        pushLog({ src: "ws", svc: "user", txt: "session ready · identifying admin", dur: "—" });
        break;

      case "status":
        if (ev.status === "thinking") {
          pushLog({ src: "llama", svc: "llama", txt: "reasoning · tool_choice = auto", dur: "—" });
        } else if (ev.status === "executing_tools") {
          pushLog({ src: "llama", svc: "llama", txt: `executing ${ev.count} tool${ev.count > 1 ? "s" : ""} in parallel`, dur: "—" });
        }
        break;

      case "agent_thought":
        pushLog({ src: "llama", svc: "llama", txt: `thought: ${(ev.text || "").slice(0, 60)}`, dur: `step ${ev.step}` });
        break;

      case "tool_start": {
        setIsThinking(false);
        const svc = activateServer(ev.tool);
        pushLog({ src: svc || "llama", svc: svc || "llama", txt: `→ ${ev.tool}`, dur: "—" });
        setStats(s => ({ ...s, tools: s.tools + 1 }));

        const newTool = {
          callId: ev.call_id,
          tool: ev.tool,
          label: ev.label || ev.tool,
          server: svc,
          state: "running",
          durationMs: null,
          error: null,
          resultPreview: null,
        };

        setMessages(msgs => {
          // If there's an active tool bundle, add to it; else create new
          const lastBundle = [...msgs].reverse().find(m => m.kind === "bundle");
          if (lastBundle && lastBundle.tools.some(t => t.state === "running")) {
            return msgs.map(m => m.id === lastBundle.id
              ? { ...m, tools: [...m.tools, newTool] }
              : m);
          }
          const bundleId = "bundle-" + ev.call_id;
          // Set ref outside updater — this is a best-effort tracking ID used only for cleanup.
          setTimeout(() => { toolBundleRef.current = bundleId; }, 0);
          return [...msgs, { id: bundleId, kind: "bundle", tools: [newTool] }];
        });
        break;
      }

      case "confirm_required": {
        setIsThinking(false);
        setMessages(msgs => [...msgs, {
          id: "confirm-" + ev.call_id,
          kind: "confirm",
          tool: ev.tool,
          label: ev.label || ev.tool,
          args: ev.arguments || {},
        }]);
        break;
      }

      case "tool_complete": {
        const svc = serverFromTool(ev.tool);
        setDoneNodes(d => new Set([...d, ...(SERVER_FLOW[svc]?.nodes || [])]));

        const ok = !ev.error;
        setStats(s => ({ ...s, ok: s.ok + (ok ? 1 : 0), warn: s.warn + (!ok ? 1 : 0) }));
        pushLog({ src: svc || "llama", svc: svc || "llama", txt: `← ${ev.tool} ${ok ? "ok" : "error"}`, dur: ev.duration_ms ? `${ev.duration_ms}ms` : "—", err: !ok });

        setMessages(msgs => msgs.map(m => {
          if (m.kind !== "bundle") return m;
          const tools = m.tools.map(t => {
            if (t.callId !== ev.call_id) return t;
            return { ...t, state: "done", durationMs: ev.duration_ms, error: ev.error || null, resultPreview: ev.result_preview || null };
          });
          return { ...m, tools };
        }));
        break;
      }

      case "stream_token": {
        // Ignore late tokens that arrive after the stream has already finished.
        if (!streamRef.current.awaitingResponse && !streamRef.current.msgId) break;
        setIsThinking(false);
        setStats(s => ({ ...s, tokens: s.tokens + 1 }));
        streamRef.current.text += ev.token;
        const txt = streamRef.current.text;
        const msgId = streamRef.current.msgId;

        if (!msgId) {
          const newId = "assist-" + Date.now();
          streamRef.current.msgId = newId;
          setMessages(msgs => [...msgs, {
            id: newId, kind: "assistant",
            text: txt, streaming: true, cardEvents: [], suggestions: [], ts: Date.now()
          }]);
        } else {
          setMessages(msgs => msgs.map(m => m.id === msgId ? { ...m, text: txt } : m));
        }
        break;
      }

      case "cards": {
        const msgId = streamRef.current.msgId;
        const card = { card_type: ev.card_type, data: ev.data };
        streamRef.current.cards = [...streamRef.current.cards, card];
        if (msgId) {
          setMessages(msgs => msgs.map(m => m.id === msgId ? { ...m, cardEvents: streamRef.current.cards } : m));
        }
        break;
      }

      case "suggestions": {
        const msgId = streamRef.current.msgId;
        if (msgId && ev.items?.length) {
          setMessages(msgs => msgs.map(m => m.id === msgId ? { ...m, suggestions: ev.items } : m));
        }
        break;
      }

      case "done":
        setIsThinking(false);
        clearActive(); // stops the traveling dot; lit paths stay highlighted
        setMessages(msgs => msgs.map(m => m.kind === "assistant" ? { ...m, streaming: false } : m));
        streamRef.current = { text: "", cards: [], msgId: null, awaitingResponse: false };
        toolBundleRef.current = null;
        setBusy(false);
        break;

      case "error":
        setIsThinking(false);
        clearActive();
        setMessages(msgs => msgs.map(m => m.kind === "assistant" ? { ...m, streaming: false } : m));
        streamRef.current.awaitingResponse = false;
        setBusy(false);
        if (ev.message) {
          const errId = "err-" + Date.now();
          setMessages(msgs => [...msgs, { id: errId, kind: "error", message: ev.message }]);
          pushLog({ src: "error", svc: "user", txt: ev.message.slice(0, 80), err: true });
        }
        if (!ev.recoverable) setConnected(false);
        break;

      default: break;
    }
  }, [activateServer, clearActive, pushLog]);

  // Start WebSocket on login
  useEffect(() => {
    if (identity?.identity_uuid) {
      initWS(identity.identity_uuid);
    }
    return () => { wsRef.current?.close(); };
  }, [identity?.identity_uuid]);

  // Load conversations on mount when identity is already set (e.g. after page refresh)
  const didLoadConvs = useRef(false);
  useEffect(() => {
    if (identity?.identity_uuid && !didLoadConvs.current) {
      didLoadConvs.current = true;
      loadConversations();
    }
  }, [identity?.identity_uuid, loadConversations]);

  const handleLogin = useCallback((id) => {
    setJustLoggedOut(false);
    setIdentity(id);
    setMessages([]);
    streamRef.current = { text: "", cards: [], msgId: null, awaitingResponse: false };
    loadConversations();
  }, [loadConversations]);

  const handleLogout = useCallback(async () => {
    if (wsRef.current) { wsRef.current.onclose = null; wsRef.current.close(); wsRef.current = null; }
    try { await fetch("/api/admin/logout", { method: "POST" }); } catch { /* ignore */ }
    sessionStorage.removeItem("admin_identity");
    sessionStorage.removeItem("active_conv_id");
    setJustLoggedOut(true);
    setIdentity(null);
    setMessages([]);
    setHistory([]);
    setActiveConvId(null);
    setBusy(false);
    streamRef.current = { text: "", cards: [], msgId: null, awaitingResponse: false };
  }, []);

  const handleSend = (text) => {
    if (!connected || busy) return;
    setBusy(true);
    setMessages(msgs => {
      // Register conversation in DB on first message
      if (msgs.length === 0) {
        const convId = sessionId.current;
        const label = text.length > 52 ? text.slice(0, 49) + "…" : text;
        fetch("/api/conversations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ session_id: convId, label }),
        }).then(() => loadConversations()).catch(() => {});
        setActiveConvId(convId);
      }
      return [...msgs, { id: "user-" + Date.now(), kind: "user", text, ts: Date.now() }];
    });
    streamRef.current = { text: "", cards: [], msgId: null, awaitingResponse: true };
    toolBundleRef.current = null;
    setDoneNodes(new Set());
    setLitNodes(new Set());
    setLitEdges(new Set());
    clearActive();
    pushLog({ src: "user", svc: "user", txt: `chat → "${text.slice(0, 50)}"`, dur: "—" });
    setIsThinking(true);
    wsRef.current?.send(JSON.stringify({ type: "chat", message: text }));
  };

  // ─── Conversation history (DB-backed, per admin) ──────────────────────────
  const [history, setHistory] = useState([]);
  const [activeConvId, setActiveConvId] = useState(null);

  const loadConversations = useCallback(() => {
    fetch("/api/conversations")
      .then(r => {
        if (r.status === 401) {
          // Cookie expired — sessionStorage still has identity but the 8h auth cookie is gone.
          // Force a full re-login so the user gets a fresh cookie.
          console.warn("conversations: session cookie expired, forcing re-login");
          sessionStorage.removeItem("admin_identity");
          handleLogout();
          return { conversations: [] };
        }
        return r.ok ? r.json() : { conversations: [] };
      })
      .then(d => {
        const convs = (d.conversations || []).map(c => ({
          id: c.session_id,
          sessionId: c.session_id,
          label: c.label,
          time: c.last_active ? new Date(c.last_active * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "",
          pinned: c.pinned,
          active: c.active,
        }));
        setHistory(convs);
      })
      .catch(() => {});
  }, [handleLogout]);

  const onPick = useCallback(async (id) => {
    const entry = history.find(h => h.id === id);
    if (!entry?.sessionId) { setActiveConvId(id); return; }
    // Close current WS without triggering auto-reconnect
    if (wsRef.current) { wsRef.current.onclose = null; wsRef.current.close(); }
    sessionId.current = entry.sessionId;
    setActiveConvId(id);
    setMessages([]);
    streamRef.current = { text: "", cards: [], msgId: null };
    setBusy(false);
    // Fetch stored messages from backend
    try {
      const res = await fetch(`/api/session/${entry.sessionId}/messages`);
      if (!res.ok) {
        addToast(`Kon sessie niet laden (HTTP ${res.status}). Je kan wel verder chatten.`, "error");
      } else {
        const data = await res.json();
        if (Array.isArray(data.messages) && data.messages.length > 0) {
          setMessages(data.messages.map((m, i) => ({
            id: `hist-${i}-${entry.sessionId}`,
            kind: m.role === "user" ? "user" : "assistant",
            text: m.text,
            streaming: false,
            cardEvents: [],
            suggestions: [],
          })));
        } else {
          addToast("Geen berichtengeschiedenis gevonden voor dit gesprek.", "info");
        }
      }
    } catch (err) {
      addToast("Sessie laden mislukt. Je kan wel verder chatten.", "error");
    }
    // Reconnect with the old session_id (backend will restore context)
    if (identity?.identity_uuid) initWS(identity.identity_uuid);
  }, [history, identity, initWS, addToast]);

  // Persist activeConvId to sessionStorage and Database when it changes
  useEffect(() => {
    if (activeConvId) {
      sessionStorage.setItem("active_conv_id", activeConvId);
      fetch(`/api/conversations/${activeConvId}/active`, { method: "PUT" }).catch(() => {});
    } else {
      sessionStorage.removeItem("active_conv_id");
      fetch("/api/conversations/active", { method: "DELETE" }).catch(() => {});
    }
  }, [activeConvId]);

  // Auto-restore active conversation on mount/refresh once history is loaded
  const didRestore = useRef(false);
  useEffect(() => {
    if (identity?.identity_uuid && history.length > 0 && !activeConvId && !didRestore.current) {
      // 1. Try DB-persisted active conversation first
      const dbActiveEntry = history.find(h => h.active);
      if (dbActiveEntry) {
        didRestore.current = true;
        onPick(dbActiveEntry.id);
      } else {
        // 2. Fall back to sessionStorage if DB active is not found/not set yet
        const savedActiveId = sessionStorage.getItem("active_conv_id");
        if (savedActiveId) {
          const entry = history.find(h => h.id === savedActiveId);
          if (entry) {
            didRestore.current = true;
            onPick(entry.id);
          }
        }
      }
    }
  }, [identity?.identity_uuid, history, activeConvId, onPick]);

  const onPin = useCallback((id) => {
    const entry = history.find(h => h.id === id);
    if (!entry) return;
    const newPinned = !entry.pinned;
    // Optimistic update
    setHistory(prev => prev.map(h => h.id === id ? { ...h, pinned: newPinned } : h));
    fetch(`/api/conversations/${id}/pin`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pinned: newPinned }),
    }).then(r => { if (!r.ok) loadConversations(); }).catch(() => loadConversations());
  }, [history, loadConversations]);

  const onDelete = useCallback((id) => {
    setHistory(prev => prev.filter(h => h.id !== id));
    if (id === activeConvId) setActiveConvId(null);
    fetch(`/api/conversations/${id}`, { method: "DELETE" })
      .then(r => { if (!r.ok) loadConversations(); })
      .catch(() => loadConversations());
  }, [activeConvId, loadConversations]);

  const handleSuggest = (text) => handleSend(text);
  const handleNew = useCallback(() => {
    sessionId.current = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36);
    if (wsRef.current) { wsRef.current.onclose = null; wsRef.current.close(); }
    setMessages([]);
    streamRef.current = { text: "", cards: [], msgId: null };
    clearActive();
    setDoneNodes(new Set());
    setLitNodes(new Set());
    setLitEdges(new Set());
    setLog([]);
    setStats({ tools: 0, ok: 0, warn: 0, tokens: 0 });
    setActiveConvId(null);
    if (identity?.identity_uuid) initWS(identity.identity_uuid);
  }, [clearActive, identity, initWS]);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e) => {
      const tag = document.activeElement?.tagName;
      const inInput = tag === "INPUT" || tag === "TEXTAREA";
      // ⌘N / Ctrl+N → new conversation
      if ((e.metaKey || e.ctrlKey) && e.key === "n") {
        e.preventDefault();
        handleNew();
        return;
      }
      // / → focus composer (when not already in a text field)
      if (e.key === "/" && !inInput) {
        e.preventDefault();
        document.querySelector(".composer textarea")?.focus();
        return;
      }
      // Escape → close settings modal, then blur active input
      if (e.key === "Escape") {
        if (showSettings) { setShowSettings(false); return; }
        if (inInput) document.activeElement?.blur();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handleNew, showSettings]);

  if (!identity) {
    return <LoginScreen onLogin={handleLogin} skipAutoLogin={justLoggedOut} />;
  }

  return (
    <div className={`app${sidebarOpen ? "" : " no-sidebar"}${flowOpen ? "" : " no-flow"}`}>
      <Topbar
        identity={identity}
        connected={connected}
        serverCount={mcpServerCount}
        onSettings={() => setShowSettings(true)}
        sidebarOpen={sidebarOpen}
        onToggleSidebar={() => setSidebarOpen(v => !v)}
        flowOpen={flowOpen}
        onToggleFlow={() => setFlowOpen(v => !v)}
        onLogout={handleLogout}
      />

      {sidebarOpen && <Sidebar
        history={history}
        activeConvId={activeConvId}
        onPick={onPick}
        onPin={onPin}
        onDelete={onDelete}
        onNew={handleNew}
        mode={mode}
        setMode={setMode}
      />}

      {mode === "agent" ? (
        <>
          <main className="main">
            <div className="main-head">
              <h1>Admin Chat</h1>
              <span className="sub">
                <b>{stats.tools}</b> tool calls · <b>{stats.ok}</b> OK · <b>{stats.tokens}</b> tokens
              </span>
              <div className="main-head-spacer"></div>
              <span className={`tag ${connected ? "" : "warn"}`}>
                <span className="pulse"></span>{connected ? "Agent connected" : "Reconnecting…"}
              </span>
            </div>

            <DashboardStrip kpis={dashKpis} onOpenMonitoring={() => setFlowTab("monitoring")} />

            <div className="messages" ref={messagesRef}>
              <div className="day-divider">Today</div>

              {messages.length === 0 && (
                <div style={{margin:"auto",textAlign:"center",maxWidth:400,padding:"32px 20px"}}>
                  <div style={{width:56,height:56,borderRadius:14,background:"linear-gradient(160deg, var(--primary), var(--ink-2))",display:"flex",alignItems:"center",justifyContent:"center",margin:"0 auto 20px",boxShadow:"0 8px 24px rgba(31,58,138,.25)"}}>
                    <svg width="26" height="26" viewBox="0 0 24 24" fill="white"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/></svg>
                  </div>
                  <h2 style={{fontSize:18,fontWeight:700,marginBottom:8,letterSpacing:"-.015em"}}>What can I help with?</h2>
                  <p style={{fontSize:13,color:"var(--muted)",lineHeight:1.6}}>Query sessions, invoices, member registrations, Kassa orders, or service health across all platforms.</p>
                  <div style={{display:"flex",flexWrap:"wrap",gap:8,justifyContent:"center",marginTop:20}}>
                    {SUGGESTIONS_INITIAL.map((s, i) => (
                      <button key={i} onClick={() => handleSend(s)}
                        style={{padding:"7px 14px",borderRadius:99,background:"var(--surface)",border:"1px solid var(--line)",fontSize:12,fontWeight:500,color:"var(--muted)",cursor:"pointer",boxShadow:"var(--shadow-sm)"}}>
                        {s}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {messages.map(m => {
                if (m.kind === "user")      return <UserMessage key={m.id} text={m.text} email={identity?.email} ts={m.ts} />;
                if (m.kind === "bundle")    return settings.showBundle ? <ToolBundle key={m.id} tools={m.tools} /> : null;
                if (m.kind === "assistant") return (
                  <AssistantMessage key={m.id}
                    text={m.text} streaming={m.streaming}
                    cardEvents={m.cardEvents} suggestions={m.suggestions}
                    onSuggest={handleSuggest} ts={m.ts}
                  />
                );
                if (m.kind === "error")     return <ErrorToast key={m.id} message={m.message} />;
                if (m.kind === "confirm")   return <ConfirmCard key={m.id} tool={m.tool} label={m.label} args={m.args} />;
                return null;
              })}

              {isThinking && <ThinkingBubble label="thinking…" />}
            </div>

            <Composer onSend={handleSend} busy={busy} disabled={!connected} />
          </main>

          {flowOpen && <FlowColumn
            activeNodes={activeNodes}
            doneNodes={doneNodes}
            activeEdges={activeEdges}
            litNodes={litNodes}
            litEdges={litEdges}
            log={log}
            onClear={() => setLog([])}
            stats={stats}
            tab={flowTab}
            setTab={setFlowTab}
          />}
        </>
      ) : mode === "msgflow" ? (
        <window.MessageFlowScreen />
      ) : (
        <window.LogsScreen
          levelFilter={logLevelFilter}
          setLevelFilter={setLogLevelFilter}
          query={logQuery}
          setQuery={setLogQuery}
          themeName={settings.theme}
        />
      )}

      {showSettings && (
        <SettingsModal settings={settings} onChange={changeSetting} onClose={() => setShowSettings(false)} />
      )}

      <ToastContainer toasts={toasts} onDismiss={dismissToast} />

      <style>{`.cursor-blink { display:inline-block; width:2px; height:14px; background:var(--accent); margin-left:2px; vertical-align:middle; animation:blink .8s step-end infinite; } @keyframes blink { 50% { opacity:0; } }`}</style>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
