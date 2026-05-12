/* Event Chatbot Widget — self-contained, embeds into any page */
(function () {
  'use strict';

  const UUID = window.CHATBOT_USER_UUID || '';
  const HOST = window.CHATBOT_HOST || 'localhost:8000';
  const WS_BASE = `ws://${HOST}/ws`;
  const SESSION_ID = (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2));

  if (!UUID) {
    // Not logged in — don't render the widget
    return;
  }

  // ─── Icons ──────────────────────────────────────────────────────────────────

  const ICON_CHAT = `<svg viewBox="0 0 24 24"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-2 12H6v-2h12v2zm0-3H6V9h12v2zm0-3H6V6h12v2z"/></svg>`;
  const ICON_SEND = `<svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>`;
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
          Ask me about your sessions, invoices, or anything about the event.
        </div>
      </div>

      <div class="chatbot-input-row">
        <input
          type="text"
          class="chatbot-input"
          id="chatbot-input"
          placeholder="Ask something..."
          disabled
          maxlength="500"
        />
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

  // ─── State ───────────────────────────────────────────────────────────────────

  let ws = null;
  let isOpen = false;
  let isReady = false;
  let isBusy = false;
  let activeBubble = null;    // The assistant bubble currently being filled
  let activeBadges = {};      // tool name → badge DOM element
  let unreadCount = 0;

  // ─── WebSocket ───────────────────────────────────────────────────────────────

  function connect() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

    ws = new WebSocket(`${WS_BASE}/${SESSION_ID}`);

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'identify', identity_uuid: UUID }));
    };

    ws.onmessage = (e) => {
      try {
        handleEvent(JSON.parse(e.data));
      } catch (err) {
        console.error('[Chatbot] parse error', err);
      }
    };

    ws.onerror = () => {
      setStatus(false, 'Connection error');
    };

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
        setStatus(true, 'Online — ask me anything');
        setInputEnabled(true);
        break;

      case 'tool_start':
        ensureActiveBubble();
        addBadge(ev.tool, ev.label, ev.service);
        break;

      case 'tool_complete':
        completeBadge(ev.tool, ev.duration_ms, ev.error);
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
        finalizeActiveBubble();
        setInputEnabled(true);
        isBusy = false;
        break;

      case 'error':
        showError(ev.message, ev.recoverable);
        if (!ev.recoverable) setInputEnabled(false);
        else { setInputEnabled(true); isBusy = false; }
        break;
    }
  }

  // ─── Message bubble management ───────────────────────────────────────────────

  function addUserBubble(text) {
    const el = document.createElement('div');
    el.className = 'chatbot-msg chatbot-msg--user';
    el.innerHTML = `<div class="chatbot-msg-bubble">${escHtml(text)}</div>`;
    $messages.appendChild(el);
    scrollBottom();
  }

  function ensureActiveBubble() {
    if (activeBubble) return;

    // Remove typing indicator if present
    const existing = $messages.querySelector('.chatbot-typing-wrap');
    if (existing) existing.remove();

    const wrap = document.createElement('div');
    wrap.className = 'chatbot-msg chatbot-msg--assistant';

    const badgeRow = document.createElement('div');
    badgeRow.className = 'chatbot-badges';

    const bubble = document.createElement('div');
    bubble.className = 'chatbot-msg-bubble';
    const cursor = document.createElement('span');
    cursor.className = 'chatbot-cursor';
    bubble.appendChild(cursor);

    wrap.appendChild(badgeRow);
    wrap.appendChild(bubble);
    $messages.appendChild(wrap);

    activeBubble = { wrap, badgeRow, bubble, cursor, textNode: null, cardArea: null, chipArea: null };
    scrollBottom();
  }

  function showTypingIndicator() {
    const wrap = document.createElement('div');
    wrap.className = 'chatbot-msg chatbot-msg--assistant chatbot-typing-wrap';
    wrap.innerHTML = `
      <div class="chatbot-typing">
        <div class="chatbot-typing-dot"></div>
        <div class="chatbot-typing-dot"></div>
        <div class="chatbot-typing-dot"></div>
      </div>`;
    $messages.appendChild(wrap);
    scrollBottom();
    return wrap;
  }

  function finalizeActiveBubble() {
    if (!activeBubble) return;
    if (activeBubble.cursor && activeBubble.cursor.parentNode) {
      activeBubble.cursor.remove();
    }
    activeBubble = null;
    activeBadges = {};
    scrollBottom();
  }

  // ─── Badge management ────────────────────────────────────────────────────────

  function addBadge(tool, label, service) {
    if (!activeBubble) return;
    const badge = document.createElement('span');
    badge.className = `chatbot-badge chatbot-badge--${service || 'unknown'}`;
    badge.innerHTML = `<span class="chatbot-badge-dot"></span>${escHtml(label)}`;
    activeBubble.badgeRow.appendChild(badge);
    activeBadges[tool] = badge;
    scrollBottom();
  }

  function completeBadge(tool, durationMs, error) {
    const badge = activeBadges[tool];
    if (!badge) return;
    badge.classList.add('chatbot-badge--done');
    const icon = error ? '✕' : '✓';
    const timeStr = durationMs != null ? `${durationMs}ms` : '';
    badge.innerHTML = `<span class="chatbot-badge-check">${icon}</span>${badge.textContent.trim().replace(/✓|✕/g,'').trim()} <span class="chatbot-badge-time">${timeStr}</span>`;
  }

  // ─── Text streaming ──────────────────────────────────────────────────────────

  function appendToken(token) {
    if (!activeBubble) return;
    const { bubble, cursor } = activeBubble;
    if (!activeBubble.textNode) {
      activeBubble.textNode = document.createTextNode('');
      bubble.insertBefore(activeBubble.textNode, cursor);
    }
    activeBubble.textNode.textContent += token;
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
        activeBubble && activeBubble.chipArea && activeBubble.chipArea.remove();
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

    // Remove any stale suggestion chips from last bubble
    root.querySelectorAll('.chatbot-suggestions').forEach(el => el.remove());

    isBusy = true;
    setInputEnabled(false);
    $input.value = '';

    addUserBubble(text);
    showTypingIndicator();
    activeBubble = null; // Will be created on first event

    send('chat', { message: text });
  }

  // ─── Error display ───────────────────────────────────────────────────────────

  function showError(message, recoverable) {
    // Remove typing indicator
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
    $status.className = `chatbot-header-status${online ? '' : ' chatbot-status-offline'}`;
    $subtitle.textContent = subtitle || (online ? 'Online' : 'Offline');
  }

  function setInputEnabled(enabled) {
    $input.disabled = !enabled;
    $send.disabled = !enabled;
    if (enabled) $input.focus();
  }

  function scrollBottom() {
    $messages.scrollTop = $messages.scrollHeight;
  }

  function bumpUnread() {
    unreadCount++;
    const badge = root.querySelector('#chatbot-badge');
    badge.textContent = unreadCount;
    badge.style.display = 'flex';
  }

  function clearUnread() {
    unreadCount = 0;
    const badge = root.querySelector('#chatbot-badge');
    badge.style.display = 'none';
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
    } catch {
      return dateStr;
    }
  }

  function getStatusClass(status) {
    const s = (status || '').toLowerCase();
    if (s === 'paid') return 'chatbot-status-paid';
    if (s === 'pending') return 'chatbot-status-pending';
    if (s === 'overdue') return 'chatbot-status-overdue';
    return 'chatbot-status-draft';
  }

  // ─── Popup open/close ────────────────────────────────────────────────────────

  function openPopup() {
    isOpen = true;
    $popup.classList.add('chatbot-open');
    clearUnread();
    if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
      connect();
    }
    $input.focus();
  }

  function closePopup() {
    isOpen = false;
    $popup.classList.remove('chatbot-open');
  }

  // ─── Event listeners ─────────────────────────────────────────────────────────

  $bubble.addEventListener('click', () => isOpen ? closePopup() : openPopup());
  $close.addEventListener('click', closePopup);

  $input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage($input.value);
    }
  });

  $send.addEventListener('click', () => sendMessage($input.value));

  // Close on backdrop click
  document.addEventListener('click', (e) => {
    if (isOpen && !root.contains(e.target)) closePopup();
  });

  // ─── Boot ────────────────────────────────────────────────────────────────────

  connect();

})();
