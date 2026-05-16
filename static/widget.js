/* Event Chatbot Widget — self-contained, embeds into any page */
(function () {
  'use strict';

  const UUID = window.CHATBOT_USER_UUID || '';
  const HOST = window.CHATBOT_HOST || 'localhost:8000';
  const WS_BASE = `ws://${HOST}/ws`;
  const SESSION_ID = (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2));

  if (!UUID) return;

  // ─── Icons ───────────────────────────────────────────────────────────────────

  const ICON_CHAT  = `<svg viewBox="0 0 24 24"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-2 12H6v-2h12v2zm0-3H6V9h12v2zm0-3H6V6h12v2z"/></svg>`;
  const ICON_SEND  = `<svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>`;
  const ICON_CLOSE = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>`;

  // ─── DOM Construction ────────────────────────────────────────────────────────

  const root = document.createElement('div');
  root.className = 'chatbot-widget';

  root.innerHTML = `
    <button class="chatbot-bubble" id="chatbot-bubble" aria-label="Open assistant">
      ${ICON_CHAT}
      <span class="chatbot-bubble-badge" id="chatbot-badge">1</span>
    </button>

    <div class="chatbot-popup" id="chatbot-popup">
      <div class="chatbot-header">
        <div class="chatbot-header-icon">${ICON_CHAT}</div>
        <div class="chatbot-header-info">
          <div class="chatbot-header-title">Event Assistant</div>
          <div class="chatbot-header-subtitle" id="chatbot-subtitle">Connecting...</div>
        </div>
        <div class="chatbot-header-status chatbot-status-offline" id="chatbot-status"></div>
        <button class="chatbot-close" id="chatbot-close" aria-label="Close">${ICON_CLOSE}</button>
      </div>

      <div class="chatbot-messages" id="chatbot-messages">
        <div class="chatbot-welcome">
          <div class="chatbot-welcome-icon">✨</div>
          <strong>Your personal event assistant</strong>
          Ask me about sessions, invoices, members, or anything about the event.
          <div class="chatbot-welcome-hint">
            <button class="chatbot-welcome-chip" id="wc1">Who registered today?</button>
            <button class="chatbot-welcome-chip" id="wc2">Show overdue invoices</button>
            <button class="chatbot-welcome-chip" id="wc3">Service health status</button>
          </div>
        </div>
      </div>

      <div class="chatbot-input-row">
        <textarea
          class="chatbot-input"
          id="chatbot-input"
          placeholder="Ask something..."
          disabled
          rows="1"
        ></textarea>
        <button class="chatbot-send" id="chatbot-send" disabled aria-label="Send">${ICON_SEND}</button>
      </div>
    </div>
  `;

  document.body.appendChild(root);

  // ─── Element references ──────────────────────────────────────────────────────

  const $bubble   = root.querySelector('#chatbot-bubble');
  const $popup    = root.querySelector('#chatbot-popup');
  const $messages = root.querySelector('#chatbot-messages');
  const $input    = root.querySelector('#chatbot-input');
  const $send     = root.querySelector('#chatbot-send');
  const $status   = root.querySelector('#chatbot-status');
  const $subtitle = root.querySelector('#chatbot-subtitle');
  const $close    = root.querySelector('#chatbot-close');

  ['wc1', 'wc2', 'wc3'].forEach(id => {
    const el = root.querySelector('#' + id);
    if (el) el.addEventListener('click', () => sendMessage(el.textContent));
  });

  // ─── State ───────────────────────────────────────────────────────────────────

  let ws          = null;
  let isOpen      = false;
  let isReady     = false;
  let isBusy      = false;
  let activeBubble = null;   // assistant bubble currently being filled
  let activeBadges = {};     // tool name → badge DOM element
  let unreadCount = 0;
  let busyTimeout = null;    // 90s safety reset

  // ─── Markdown renderer ───────────────────────────────────────────────────────

  function renderMarkdown(raw) {
    // Escape HTML
    let s = raw
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    // Fenced code blocks
    s = s.replace(/```[\w]*\n?([\s\S]*?)```/g, (_, code) =>
      `<pre><code>${code.trim()}</code></pre>`);

    // Inline code
    s = s.replace(/`([^`\n]+?)`/g, '<code>$1</code>');

    // Bold
    s = s.replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>');

    // Italic (single *, not **)
    s = s.replace(/(?<![*])\*(?![*])([^*\n]+?)(?<![*])\*(?![*])/g, '<em>$1</em>');

    // Process line by line for lists / paragraphs
    const lines = s.split('\n');
    const out = [];
    let inUl = false;
    let inOl = false;

    for (const line of lines) {
      const ulMatch = line.match(/^[-*•]\s+(.+)/);
      const olMatch = line.match(/^\d+\.\s+(.+)/);

      if (ulMatch) {
        if (!inUl) { if (inOl) { out.push('</ol>'); inOl = false; } out.push('<ul>'); inUl = true; }
        out.push(`<li>${ulMatch[1]}</li>`);
      } else if (olMatch) {
        if (!inOl) { if (inUl) { out.push('</ul>'); inUl = false; } out.push('<ol>'); inOl = true; }
        out.push(`<li>${olMatch[1]}</li>`);
      } else {
        if (inUl) { out.push('</ul>'); inUl = false; }
        if (inOl) { out.push('</ol>'); inOl = false; }
        if (line.trim() === '') {
          out.push('<p></p>');
        } else {
          out.push(`<p>${line}</p>`);
        }
      }
    }
    if (inUl) out.push('</ul>');
    if (inOl) out.push('</ol>');

    return out.join('');
  }

  // ─── WebSocket ───────────────────────────────────────────────────────────────

  function connect() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

    ws = new WebSocket(`${WS_BASE}/${SESSION_ID}`);

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'identify', identity_uuid: UUID }));
    };

    ws.onmessage = (e) => {
      try { handleEvent(JSON.parse(e.data)); }
      catch (err) { console.error('[Chatbot] parse error', err); }
    };

    ws.onerror = () => setStatus(false, 'Connection error');

    ws.onclose = () => {
      isReady = false;
      setStatus(false, 'Disconnected — reconnecting...');
      setInputEnabled(false);
      setTimeout(connect, 3000);
    };
  }

  function send(type, payload) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type, ...payload }));
    }
  }

  // ─── Event routing ───────────────────────────────────────────────────────────

  function handleEvent(ev) {
    switch (ev.type) {

      case 'ready':
        isReady = true;
        isBusy  = false;   // reset in case previous response got stuck
        clearBusyTimeout();
        setBusyState(false);
        setStatus(true, 'Online — ask me anything');
        setInputEnabled(true);
        break;

      case 'tool_start':
        ensureActiveBubble();
        updateStatusLine(`Calling ${serviceLabel(ev.tool)} service…`);
        addBadge(ev.tool, ev.label || toolDisplayName(ev.tool), serviceFromTool(ev.tool));
        break;

      case 'tool_complete':
        completeBadge(ev.tool, ev.duration_ms, ev.error);
        updateStatusLine(null);
        break;

      case 'status':
        ensureActiveBubble();
        if (ev.status === 'thinking') {
          updateStatusLine('Thinking…');
        } else if (ev.status === 'executing_tools') {
          const step = ev.step ? ` (step ${ev.step})` : '';
          updateStatusLine(`Running tools${step}…`);
        }
        break;

      case 'agent_thought':
        ensureActiveBubble();
        addAgentThought(ev.thought || ev.content || '');
        break;

      case 'stream_token':
        ensureActiveBubble();
        appendToken(ev.token);
        break;

      case 'cards':
        if (activeBubble) renderCards(ev.card_type, ev.data);
        break;

      case 'suggestions':
        if (activeBubble) renderSuggestions(ev.items);
        break;

      case 'done':
        updateStatusLine(null);
        finalizeActiveBubble();
        isBusy = false;
        clearBusyTimeout();
        setBusyState(false);
        setInputEnabled(true);
        break;

      case 'error':
        updateStatusLine(null);
        showError(ev.message, ev.recoverable);
        clearBusyTimeout();
        if (!ev.recoverable) setInputEnabled(false);
        else { isBusy = false; setBusyState(false); setInputEnabled(true); }
        break;
    }
  }

  // ─── Service helpers ─────────────────────────────────────────────────────────

  function serviceFromTool(name) {
    if (!name) return 'unknown';
    const parts = name.split('__');
    return parts.length >= 2 ? parts[0] : 'unknown';
  }

  function serviceLabel(name) {
    const map = { crm: 'CRM', kassa: 'Kassa', monitoring: 'Monitoring', frontend: 'Frontend', facturatie: 'Facturatie' };
    return map[serviceFromTool(name)] || serviceFromTool(name);
  }

  function toolDisplayName(name) {
    if (!name) return 'tool';
    const parts = name.split('__');
    return (parts.length >= 2 ? parts[1] : name).replace(/_/g, ' ');
  }

  // ─── Busy state ──────────────────────────────────────────────────────────────

  function setBusyState(busy) {
    if (busy) {
      $status.classList.add('chatbot-status-busy');
      $status.classList.remove('chatbot-status-offline');
      $subtitle.classList.add('chatbot-subtitle-active');
    } else {
      $status.classList.remove('chatbot-status-busy');
      $subtitle.classList.remove('chatbot-subtitle-active');
    }
  }

  function startBusyTimeout() {
    clearBusyTimeout();
    busyTimeout = setTimeout(() => {
      if (!isBusy) return;
      isBusy = false;
      setBusyState(false);
      setInputEnabled(true);
      updateStatusLine(null);
      finalizeActiveBubble();
      const toast = document.createElement('div');
      toast.className = 'chatbot-error-toast';
      toast.textContent = 'Request timed out — please try again.';
      $messages.appendChild(toast);
      scrollBottom();
    }, 90000);
  }

  function clearBusyTimeout() {
    if (busyTimeout) { clearTimeout(busyTimeout); busyTimeout = null; }
  }

  // ─── Bubble management ───────────────────────────────────────────────────────

  function addUserBubble(text) {
    const el = document.createElement('div');
    el.className = 'chatbot-msg chatbot-msg--user';
    el.innerHTML = `<div class="chatbot-msg-bubble">${escHtml(text)}</div>`;
    $messages.appendChild(el);
    scrollBottom();
  }

  function ensureActiveBubble() {
    if (activeBubble) return;

    const typing = $messages.querySelector('.chatbot-typing-wrap');
    if (typing) typing.remove();

    const wrap       = document.createElement('div');
    wrap.className   = 'chatbot-msg chatbot-msg--assistant';

    const badgeRow   = document.createElement('div');
    badgeRow.className = 'chatbot-badges';

    const statusLine = document.createElement('div');
    statusLine.className = 'chatbot-status-line';
    statusLine.style.display = 'none';

    const bubble     = document.createElement('div');
    bubble.className = 'chatbot-msg-bubble';

    const cursor     = document.createElement('span');
    cursor.className = 'chatbot-cursor';
    bubble.appendChild(cursor);

    wrap.appendChild(badgeRow);
    wrap.appendChild(statusLine);
    wrap.appendChild(bubble);
    $messages.appendChild(wrap);

    activeBubble = { wrap, badgeRow, statusLine, bubble, cursor, rawText: '', cardArea: null, chipArea: null };
    scrollBottom();
  }

  function showTypingIndicator() {
    const wrap = document.createElement('div');
    wrap.className = 'chatbot-msg chatbot-msg--assistant chatbot-typing-wrap';
    wrap.innerHTML = `
      <div class="chatbot-typing">
        <span class="chatbot-typing-label">Thinking</span>
        <div class="chatbot-typing-dot"></div>
        <div class="chatbot-typing-dot"></div>
        <div class="chatbot-typing-dot"></div>
      </div>`;
    $messages.appendChild(wrap);
    scrollBottom();
    return wrap;
  }

  function updateStatusLine(text) {
    if (!activeBubble) return;
    const sl = activeBubble.statusLine;
    if (!text) {
      sl.style.display = 'none';
      sl.textContent = '';
    } else {
      sl.style.display = 'flex';
      sl.textContent = text;
    }
    scrollBottom();
  }

  function addAgentThought(thought) {
    if (!activeBubble || !thought.trim()) return;
    const el = document.createElement('div');
    el.className = 'chatbot-agent-thought';
    el.textContent = thought;
    activeBubble.bubble.insertBefore(el, activeBubble.cursor);
    scrollBottom();
  }

  function finalizeActiveBubble() {
    if (!activeBubble) return;
    const { bubble, cursor, rawText } = activeBubble;

    // Collect thought elements to preserve them
    const thoughts = Array.from(bubble.querySelectorAll('.chatbot-agent-thought'));
    bubble.innerHTML = '';
    thoughts.forEach(t => bubble.appendChild(t));

    // Render final markdown (or plain text if no markdown syntax)
    if (rawText) {
      const content = document.createElement('div');
      content.innerHTML = renderMarkdown(rawText);
      bubble.appendChild(content);
    }

    activeBubble  = null;
    activeBadges  = {};
    scrollBottom();
  }

  // ─── Badge management ────────────────────────────────────────────────────────

  function addBadge(tool, label, service) {
    if (!activeBubble) return;
    const badge = document.createElement('span');
    badge.className = `chatbot-badge chatbot-badge--${service || 'unknown'}`;
    badge.dataset.tool = tool;
    badge.innerHTML = `<span class="chatbot-badge-dot"></span>${escHtml(label)}`;
    activeBubble.badgeRow.appendChild(badge);
    activeBadges[tool] = badge;
    scrollBottom();
  }

  function completeBadge(tool, durationMs, error) {
    const badge = activeBadges[tool];
    if (!badge) return;
    badge.classList.add('chatbot-badge--done');
    const icon    = error ? '✕' : '✓';
    const timeStr = durationMs != null ? `${durationMs}ms` : '';
    // Grab label text (everything after the dot span)
    const dot = badge.querySelector('.chatbot-badge-dot');
    const name = dot ? (badge.textContent || '').trim() : (badge.textContent || '').trim().replace(/^[✓✕]\s*/, '');
    badge.innerHTML = `<span class="chatbot-badge-check">${icon}</span>${escHtml(name)} <span class="chatbot-badge-time">${escHtml(timeStr)}</span>`;
  }

  // ─── Text streaming ──────────────────────────────────────────────────────────

  function appendToken(token) {
    if (!activeBubble) return;
    activeBubble.rawText += token;

    const { bubble, cursor } = activeBubble;

    // Preserve thought elements, stream raw text as plain text for responsiveness
    const thoughts = Array.from(bubble.querySelectorAll('.chatbot-agent-thought'));
    bubble.innerHTML = '';
    thoughts.forEach(t => bubble.appendChild(t));

    const preview = document.createTextNode(activeBubble.rawText);
    bubble.appendChild(preview);
    bubble.appendChild(cursor);

    scrollBottom();
    if (!isOpen) bumpUnread();
  }

  // ─── Card rendering ──────────────────────────────────────────────────────────

  function renderCards(cardType, data) {
    if (!activeBubble) return;
    if (!activeBubble.cardArea) {
      activeBubble.cardArea = document.createElement('div');
      activeBubble.cardArea.className = 'chatbot-cards';
      activeBubble.wrap.appendChild(activeBubble.cardArea);
    }
    const area = activeBubble.cardArea;

    if (cardType === 'session') {
      data.forEach(s => {
        const card = document.createElement('div');
        card.className = 'chatbot-card';
        const dateStr = formatDate(s.date);
        card.innerHTML = `
          <div class="chatbot-session-name">${escHtml(s.name)}</div>
          <div class="chatbot-session-meta">
            ${dateStr ? `<span>📅 ${escHtml(dateStr)}</span>` : ''}
            ${s.location ? `<span>📍 ${escHtml(s.location)}</span>` : ''}
          </div>`;
        area.appendChild(card);
      });
    } else if (cardType === 'invoice') {
      data.forEach(inv => {
        const card = document.createElement('div');
        card.className = 'chatbot-card';
        const statusClass = getStatusClass(inv.status);
        card.innerHTML = `
          <div class="chatbot-invoice-amount">€${escHtml(inv.amount)}</div>
          <div class="chatbot-invoice-meta">
            <span class="chatbot-invoice-status ${statusClass}">${escHtml(inv.status || 'unknown')}</span>
            ${inv.date ? `<span>${escHtml(formatDate(inv.date))}</span>` : ''}
          </div>`;
        area.appendChild(card);
      });
    } else if (cardType === 'invoice_total') {
      const card = document.createElement('div');
      card.className = 'chatbot-card';
      card.innerHTML = `
        <div class="chatbot-total-amount">€${escHtml(data.total_amount)} ${escHtml((data.currency || 'EUR').toUpperCase())}</div>
        <div class="chatbot-total-label">${data.count} invoice${data.count !== 1 ? 's' : ''} total</div>`;
      area.appendChild(card);
    }
    scrollBottom();
  }

  // ─── Suggestion chips ────────────────────────────────────────────────────────

  function renderSuggestions(items) {
    if (!activeBubble || !items || !items.length) return;
    if (!activeBubble.chipArea) {
      activeBubble.chipArea = document.createElement('div');
      activeBubble.chipArea.className = 'chatbot-suggestions';
      activeBubble.wrap.appendChild(activeBubble.chipArea);
    }
    items.forEach(text => {
      const chip = document.createElement('button');
      chip.className = 'chatbot-chip';
      chip.textContent = text;
      chip.onclick = () => {
        if (activeBubble && activeBubble.chipArea) activeBubble.chipArea.remove();
        sendMessage(text);
      };
      activeBubble.chipArea.appendChild(chip);
    });
    scrollBottom();
  }

  // ─── Send message ────────────────────────────────────────────────────────────

  function sendMessage(text) {
    text = text.trim();
    if (!text || isBusy || !isReady) return;

    root.querySelectorAll('.chatbot-suggestions').forEach(el => el.remove());

    isBusy = true;
    setBusyState(true);
    setInputEnabled(false);
    $input.value = '';
    autoGrow($input);
    try { localStorage.removeItem(DRAFT_KEY); } catch {}

    addUserBubble(text);
    showTypingIndicator();
    activeBubble = null;

    startBusyTimeout();
    send('chat', { message: text });
  }

  // ─── Error display ───────────────────────────────────────────────────────────

  function showError(message, recoverable) {
    const typing = $messages.querySelector('.chatbot-typing-wrap');
    if (typing) typing.remove();
    finalizeActiveBubble();

    const toast = document.createElement('div');
    toast.className = 'chatbot-error-toast';
    toast.textContent = message || 'Something went wrong.';
    $messages.appendChild(toast);
    scrollBottom();
  }

  // ─── UI helpers ──────────────────────────────────────────────────────────────

  function setStatus(online, subtitle) {
    if (online) {
      $status.className = 'chatbot-header-status';
    } else {
      $status.className = 'chatbot-header-status chatbot-status-offline';
    }
    $subtitle.textContent = subtitle || (online ? 'Online' : 'Offline');
  }

  function setInputEnabled(enabled) {
    $input.disabled = !enabled;
    $send.disabled  = !enabled;
    if (enabled) $input.focus();
  }

  function autoGrow(el) {
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 90) + 'px';
  }

  function scrollBottom() {
    requestAnimationFrame(() => { $messages.scrollTop = $messages.scrollHeight; });
  }

  function bumpUnread() {
    unreadCount++;
    const badge = root.querySelector('#chatbot-badge');
    badge.textContent = unreadCount;
    badge.style.display = 'flex';
  }

  function clearUnread() {
    unreadCount = 0;
    root.querySelector('#chatbot-badge').style.display = 'none';
  }

  function escHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatDate(dateStr) {
    if (!dateStr) return '';
    try {
      const d = new Date(dateStr);
      if (isNaN(d.getTime())) return dateStr;
      return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    } catch { return dateStr; }
  }

  function getStatusClass(status) {
    const s = (status || '').toLowerCase();
    if (s === 'paid')    return 'chatbot-status-paid';
    if (s === 'pending') return 'chatbot-status-pending';
    if (s === 'overdue') return 'chatbot-status-overdue';
    return 'chatbot-status-draft';
  }

  // ─── Popup open/close ────────────────────────────────────────────────────────

  const DRAFT_KEY = 'chatbot_draft';

  function openPopup() {
    isOpen = true;
    $popup.classList.add('chatbot-open');
    clearUnread();
    if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) connect();
    // Restore any saved draft
    try {
      const draft = localStorage.getItem(DRAFT_KEY);
      if (draft && !$input.value) { $input.value = draft; autoGrow($input); }
    } catch {}
    $input.focus();
  }

  function closePopup() {
    isOpen = false;
    $popup.classList.remove('chatbot-open');
  }

  // ─── Event listeners ─────────────────────────────────────────────────────────

  $bubble.addEventListener('click', () => isOpen ? closePopup() : openPopup());
  $close.addEventListener('click', closePopup);

  $input.addEventListener('input', () => {
    autoGrow($input);
    try { localStorage.setItem(DRAFT_KEY, $input.value); } catch {}
  });

  $input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage($input.value);
    }
  });

  $send.addEventListener('click', () => sendMessage($input.value));

  document.addEventListener('click', (e) => {
    if (isOpen && !root.contains(e.target)) closePopup();
  });

  // ─── Boot ────────────────────────────────────────────────────────────────────

  connect();

})();
