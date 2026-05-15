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
  attach: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>,
  search: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>,
};

// ─── Rich text renderer ────────────────────────────────────────────────────
function renderRich(text) {
  const parts = text.split(/(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|\n)/g);
  return parts.map((p, i) => {
    if (p === "\n") return <br key={i} />;
    if (p.startsWith("**") && p.endsWith("**")) return <strong key={i}>{p.slice(2, -2)}</strong>;
    if (p.startsWith("*") && p.endsWith("*"))   return <em key={i}>{p.slice(1, -1)}</em>;
    if (p.startsWith("`") && p.endsWith("`"))   return <code key={i}>{p.slice(1, -1)}</code>;
    return <span key={i}>{p}</span>;
  });
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
        return null;
      })}
    </div>
  );
}

// ─── Message components ────────────────────────────────────────────────────
function UserMessage({ text, email }) {
  const initials = (email || "AD").split("@")[0].slice(0,2).toUpperCase();
  return (
    <div className="msg user">
      <div className="msg-av user">{initials}</div>
      <div className="msg-body">
        <div className="msg-meta">
          <b>{email || "Admin"}</b>
          <span>· {new Date().toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"})}</span>
        </div>
        <div className="msg-text">{renderRich(text)}</div>
      </div>
    </div>
  );
}

function AssistantMessage({ text, streaming, cursor, cardEvents, suggestions, onSuggest }) {
  return (
    <div className="msg assist">
      <div className="msg-av assist">AI</div>
      <div className="msg-body">
        <div className="msg-meta">
          <b>Admin Assistant</b>
          <span className="who-tag">llama-3.1-8b-instruct</span>
          <span>· {new Date().toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"})}</span>
        </div>
        <div className="msg-text">
          {renderRich(text)}
          {streaming && <span className="cursor-blink">▋</span>}
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

// ─── Login screen ──────────────────────────────────────────────────────────
function LoginScreen({ onLogin }) {
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const doLogin = async () => {
    const em = email.trim().toLowerCase();
    if (!em) { setError("Please enter your email address."); return; }
    setLoading(true); setError("");
    try {
      const res = await fetch("/api/identify", {
        method: "POST", headers: {"Content-Type":"application/json"},
        body: JSON.stringify({ email: em })
      });
      const data = await res.json();
      if (!res.ok || data.error) { setError(data.error || "User not found."); return; }
      sessionStorage.setItem("admin_identity", JSON.stringify(data));
      onLogin(data);
    } catch {
      setError("Could not reach server. Is it running?");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{position:"fixed",inset:0,display:"flex",alignItems:"center",justifyContent:"center",background:"var(--bg)"}}>
      <div style={{width:"100%",maxWidth:420,padding:"24px"}}>
        <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:32,justifyContent:"center"}}>
          <div style={{width:40,height:40,borderRadius:10,background:"linear-gradient(160deg, var(--primary), var(--ink-2))",display:"flex",alignItems:"center",justifyContent:"center",boxShadow:"0 4px 12px rgba(31,58,138,.35)"}}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="white"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/></svg>
          </div>
          <span style={{fontSize:18,fontWeight:700,letterSpacing:"-.015em"}}>Shift Festival</span>
          <span style={{fontSize:10,fontWeight:600,letterSpacing:".08em",textTransform:"uppercase",padding:"2px 8px",borderRadius:99,background:"var(--primary-soft)",color:"var(--primary)",border:"1px solid rgba(31,58,138,.15)"}}>Admin</span>
        </div>

        <div style={{background:"var(--surface)",border:"1px solid var(--line)",borderRadius:18,padding:"36px 32px",boxShadow:"var(--shadow-lg)"}}>
          <div style={{fontSize:20,fontWeight:700,marginBottom:4,letterSpacing:"-.01em"}}>Sign in to Admin Console</div>
          <div style={{fontSize:13,color:"var(--muted)",marginBottom:28,lineHeight:1.5}}>Enter your work email to access the event management assistant.</div>

          <div style={{marginBottom:16}}>
            <label style={{display:"block",fontSize:11,fontWeight:600,color:"var(--muted)",marginBottom:6,letterSpacing:".06em",textTransform:"uppercase"}}>Work email</label>
            <input
              type="email" value={email} placeholder="you@shiftfestival.be"
              onChange={e => setEmail(e.target.value)}
              onKeyDown={e => e.key === "Enter" && doLogin()}
              style={{width:"100%",padding:"10px 13px",background:"var(--surface)",border:"1px solid var(--line)",borderRadius:8,color:"var(--ink)",fontSize:14,fontFamily:"var(--font)",outline:"none"}}
            />
          </div>

          {error && (
            <div style={{fontSize:12,color:"var(--hot)",marginBottom:14,background:"var(--hot-soft)",border:"1px solid rgba(214,58,74,.15)",borderRadius:8,padding:"8px 12px"}}>
              {error}
            </div>
          )}

          <button
            onClick={doLogin} disabled={loading}
            style={{width:"100%",padding:"11px 16px",background:"var(--primary)",border:"none",borderRadius:8,color:"#fff",fontSize:14,fontWeight:600,fontFamily:"var(--font)",cursor:loading?"not-allowed":"pointer",opacity:loading?.5:1,display:"flex",alignItems:"center",justifyContent:"center",gap:8}}
          >
            {loading ? "Checking…" : "Continue →"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Sidebar ───────────────────────────────────────────────────────────────
function Sidebar({ history, onPick, onNew, mode, setMode }) {
  return (
    <nav className="sidebar">
      <div className="sb-mode">
        <button className={`sb-mode-btn ${mode === "agent" ? "is-active" : ""}`} onClick={() => setMode("agent")}>
          <span className="pip"></span>Agent
        </button>
        <button className={`sb-mode-btn ${mode === "logs" ? "is-active" : ""}`} onClick={() => setMode("logs")}>
          <span className="pip"></span>Live logs
        </button>
      </div>

      <button className="sb-new" onClick={onNew}>
        <span className="plus">{I.plus}</span>
        New conversation
        <span className="kbd">⌘N</span>
      </button>

      <div className="sb-section">
        <div className="sb-label">Pinned</div>
        <button className="sb-item"><span className="ic">{I.pin}</span><span className="label">Services degraded today</span></button>
        <button className="sb-item"><span className="ic">{I.pin}</span><span className="label">Revenue this week</span></button>
        <button className="sb-item"><span className="ic">{I.pin}</span><span className="label">Capacity warnings</span></button>
      </div>

      <div className="sb-section">
        <div className="sb-label">Today</div>
        {history.map(h => (
          <button key={h.id} className={`sb-item ${h.active ? "is-active" : ""}`} onClick={() => onPick(h.id)}>
            <span className="ic">{I.msg}</span>
            <span className="label">{h.label}</span>
            <span className="time">{h.time}</span>
          </button>
        ))}
      </div>

      <div className="sb-spacer"></div>
      <div className="sb-tip">
        <b>Tip — keyboard</b>
        Hit <span className="kbd">⌘K</span> to search past conversations, <span className="kbd">/</span> to focus the composer.
      </div>
    </nav>
  );
}

// ─── Topbar ────────────────────────────────────────────────────────────────
function Topbar({ identity, connected, serverCount }) {
  const initials = identity ? (identity.email || "AD").split("@")[0].slice(0,2).toUpperCase() : "??";
  return (
    <header className="topbar">
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
      <button className="icon-btn" title="Help">{I.help}</button>
      <div className="user-chip">
        <span className="av">{initials}</span>
        <span className="em">{identity ? identity.email : "…"}</span>
        <span className="role">admin</span>
      </div>
    </header>
  );
}

// ─── Composer ──────────────────────────────────────────────────────────────
function Composer({ onSend, busy, disabled }) {
  const [draft, setDraft] = useState("");
  const taRef = useRef(null);

  const submit = () => {
    if (draft.trim() && !busy && !disabled) {
      onSend(draft.trim());
      setDraft("");
    }
  };

  useEffect(() => {
    if (!taRef.current) return;
    taRef.current.style.height = "auto";
    taRef.current.style.height = Math.min(taRef.current.scrollHeight, 200) + "px";
  }, [draft]);

  return (
    <div className="composer">
      <div className="composer-inner">
        <textarea
          ref={taRef} rows="1"
          placeholder={disabled ? "Connecting to server…" : "Ask about sessions, invoices, members, orders, or service health…"}
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } }}
          disabled={busy || disabled}
        />
        <div className="composer-tools">
          <button className="composer-tool" title="Attach" type="button">{I.attach}</button>
        </div>
        <button className="send-btn" onClick={submit} disabled={busy || disabled || !draft.trim()} aria-label="Send">
          {I.send}
        </button>
      </div>
      <div className="composer-hint">
        Press <span className="kbd">↵</span> to send · <span className="kbd">⇧↵</span> for newline
      </div>
    </div>
  );
}

// ─── Main App ──────────────────────────────────────────────────────────────
function App() {
  const [identity, setIdentity] = useState(() => {
    try { return JSON.parse(sessionStorage.getItem("admin_identity") || "null"); } catch { return null; }
  });
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);

  // Chat history — array of message objects
  const [messages, setMessages] = useState([]);

  // In-flight assistant state (streaming)
  const streamRef = useRef({ text: "", cards: [], msgId: null });
  const toolBundleRef = useRef(null); // current tool bundle msgId

  // Flow graph state
  const [activeNodes, setActiveNodes] = useState(new Set());
  const [doneNodes, setDoneNodes] = useState(new Set());
  const [activeEdges, setActiveEdges] = useState(new Set());

  // Event log
  const [log, setLog] = useState([]);
  const [stats, setStats] = useState({ tools: 0, ok: 0, warn: 0, tokens: 0 });

  // Sidebar / UI state
  const [flowTab, setFlowTab] = useState("graph");
  const [mode, setMode] = useState("agent");
  const [logLevelFilter, setLogLevelFilter] = useState("any");
  const [logQuery, setLogQuery] = useState("");

  // Tweaks
  const [tweaks, setTweak] = (window.useTweaks || (() => [{ theme: "light", density: "comfy", accent: "navy" }, () => {}]))(
    /*EDITMODE-BEGIN*/{ "theme": "light", "density": "comfy", "accent": "navy" }/*EDITMODE-END*/
  );

  useEffect(() => { document.body.dataset.theme = tweaks.theme || "light"; }, [tweaks.theme]);
  useEffect(() => { document.body.dataset.density = tweaks.density || "comfy"; }, [tweaks.density]);
  useEffect(() => {
    const map = {
      navy:   { c: "#1F3A8A", dk: "#172A63", soft: "#EEF1F9", line: "#D7DEF0" },
      teal:   { c: "#0E7C66", dk: "#0A5C4D", soft: "#E6F4F1", line: "#BCDED5" },
      purple: { c: "#7C3AED", dk: "#5B21B6", soft: "#F0EBFB", line: "#D9C7F4" },
      slate:  { c: "#334155", dk: "#1E293B", soft: "#EFF1F5", line: "#D2D7E0" },
    };
    const c = map[tweaks.accent] || map.navy;
    const r = document.documentElement.style;
    r.setProperty("--primary", c.c); r.setProperty("--primary-dk", c.dk);
    r.setProperty("--primary-soft", c.soft); r.setProperty("--primary-line", c.line);
  }, [tweaks.accent]);

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
    if (!flow) {
      setActiveNodes(new Set(["user", "api", "llama"]));
      setActiveEdges(new Set(["user->api", "api->llama"]));
      return svc;
    }
    setActiveNodes(new Set(flow.nodes));
    setActiveEdges(new Set(flow.edges));
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
          toolBundleRef.current = bundleId;
          return [...msgs, { id: bundleId, kind: "bundle", tools: [newTool] }];
        });
        break;
      }

      case "tool_complete": {
        const svc = serverFromTool(ev.tool);
        setDoneNodes(d => new Set([...d, ...(SERVER_FLOW[svc]?.nodes || [])]));
        clearActive();

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
        setStats(s => ({ ...s, tokens: s.tokens + 1 }));
        streamRef.current.text += ev.token;
        const txt = streamRef.current.text;
        const msgId = streamRef.current.msgId;

        if (!msgId) {
          const newId = "assist-" + Date.now();
          streamRef.current.msgId = newId;
          setMessages(msgs => [...msgs, {
            id: newId, kind: "assistant",
            text: txt, streaming: true, cardEvents: [], suggestions: []
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
        clearActive();
        setDoneNodes(new Set());
        if (streamRef.current.msgId) {
          setMessages(msgs => msgs.map(m => m.id === streamRef.current.msgId ? { ...m, streaming: false } : m));
        }
        streamRef.current = { text: "", cards: [], msgId: null };
        toolBundleRef.current = null;
        setBusy(false);
        break;

      case "error":
        clearActive();
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

  const handleLogin = (id) => {
    setIdentity(id);
    setMessages([]);
    streamRef.current = { text: "", cards: [], msgId: null };
  };

  const handleSend = (text) => {
    if (!connected || busy) return;
    setBusy(true);
    setMessages(msgs => [...msgs, { id: "user-" + Date.now(), kind: "user", text }]);
    streamRef.current = { text: "", cards: [], msgId: null };
    toolBundleRef.current = null;
    setDoneNodes(new Set());
    pushLog({ src: "user", svc: "user", txt: `chat → "${text.slice(0, 50)}"`, dur: "—" });
    wsRef.current?.send(JSON.stringify({ type: "chat", message: text }));
  };

  const handleSuggest = (text) => handleSend(text);
  const handleNew = () => {
    setMessages([]);
    streamRef.current = { text: "", cards: [], msgId: null };
    clearActive();
    setDoneNodes(new Set());
    setLog([]);
    setStats({ tools: 0, ok: 0, warn: 0, tokens: 0 });
  };

  if (!identity) {
    return <LoginScreen onLogin={handleLogin} />;
  }

  return (
    <div className="app">
      <Topbar identity={identity} connected={connected} serverCount={MCP_SERVERS.length} />

      <Sidebar
        history={HISTORY}
        onPick={() => {}}
        onNew={handleNew}
        mode={mode}
        setMode={setMode}
      />

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
                if (m.kind === "user")      return <UserMessage key={m.id} text={m.text} email={identity?.email} />;
                if (m.kind === "bundle")    return <ToolBundle key={m.id} tools={m.tools} />;
                if (m.kind === "assistant") return (
                  <AssistantMessage key={m.id}
                    text={m.text} streaming={m.streaming}
                    cardEvents={m.cardEvents} suggestions={m.suggestions}
                    onSuggest={handleSuggest}
                  />
                );
                if (m.kind === "error")     return <ErrorToast key={m.id} message={m.message} />;
                return null;
              })}

              {busy && !messages.some(m => m.kind === "assistant" && m.streaming) && !messages.some(m => m.kind === "bundle" && m.tools.some(t => t.state === "running")) && (
                <ThinkingBubble label="thinking…" />
              )}
            </div>

            <Composer onSend={handleSend} busy={busy} disabled={!connected} />
          </main>

          <FlowColumn
            activeNodes={activeNodes}
            doneNodes={doneNodes}
            activeEdges={activeEdges}
            log={log}
            onClear={() => setLog([])}
            stats={stats}
            tab={flowTab}
            setTab={setFlowTab}
          />
        </>
      ) : (
        <window.LogsScreen
          levelFilter={logLevelFilter}
          setLevelFilter={setLogLevelFilter}
          query={logQuery}
          setQuery={setLogQuery}
          themeName={tweaks.theme}
        />
      )}

      {window.TweaksPanel && (
        <window.TweaksPanel title="Tweaks">
          <window.TweakSection label="Theme">
            <window.TweakSelect
              label="Color theme"
              value={tweaks.theme}
              options={["light", "dark", "slate", "sepia", "contrast"]}
              onChange={v => setTweak("theme", v)}
            />
            <window.TweakRadio
              label="Accent color"
              value={tweaks.accent}
              options={["navy", "teal", "purple", "slate"]}
              onChange={v => setTweak("accent", v)}
            />
            <window.TweakRadio
              label="Density"
              value={tweaks.density}
              options={["cozy", "comfy", "loose"]}
              onChange={v => setTweak("density", v)}
            />
          </window.TweakSection>
        </window.TweaksPanel>
      )}

      <style>{`.cursor-blink { display:inline-block; width:2px; height:14px; background:var(--accent); margin-left:2px; vertical-align:middle; animation:blink .8s step-end infinite; } @keyframes blink { 50% { opacity:0; } }`}</style>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
