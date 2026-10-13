// Live transport enhances the server-rendered view; message HTML is still rendered by the server.
export const CHAT_LIVE_JS = String.raw`(() => {
  if (window.__chatLiveStop) window.__chatLiveStop();
  const panel = document.querySelector('[data-chat-live]');
  if (!panel) return;
  const chat = JSON.parse(panel.dataset.chatLive);
  const connection = document.querySelector('#connection-state');
  if (connection) { connection.replaceChildren(panel.querySelector('[data-live-status]')); connection.firstChild.hidden = false; }
  const status = document.querySelector('[data-live-status]');
  const signals = panel.querySelector('[data-live-signals]');
  const pane = panel.closest('.pane') || document;
  const form = pane.querySelector('.channel-compose');
  const body = form && form.querySelector('textarea');
  let ws, offset = 0, closed = false, reconnect, heartbeat, expiry, refreshing = false, again = false;
  let pending = null, sendTimeout, adoptPending = false, typingAt = 0, lastSeen = Date.now();
  const transient = new Map();
  function renderSignals() {
    signals.replaceChildren();
    for (const [key, value] of transient) {
      if (value.expires <= Date.now()) { transient.delete(key); continue; }
      const item = document.createElement('li'); item.textContent = value.text; signals.append(item);
    }
  }
  async function refresh(adopt = false) {
    if (refreshing) { again = true; adoptPending = adoptPending || adopt; return; }
    refreshing = true;
    try {
      const response = await fetch(location.href, { cache: 'no-store', redirect: 'error' });
      if (!response.ok) throw Error();
      const doc = new DOMParser().parseFromString(await response.text(), 'text/html');
      if (closed) return;
      // Only trusted same-origin server-rendered message fragments; never run returned scripts.
      for (const selector of ['.channel-messages', '.thread-root']) {
        const nextPane = pane.id ? doc.getElementById(pane.id) : doc;
        const next = nextPane && nextPane.querySelector(selector), current = pane.querySelector(selector);
        if (next && current) current.replaceChildren(...next.childNodes);
      }
      const nextPane = pane.id ? doc.getElementById(pane.id) : doc;
      const nextHead = nextPane && nextPane.querySelector('.channel-compose input[name="after"]');
      const currentHead = form && form.querySelector('input[name="after"]');
      // Keep the write's original read-before-write watermark while a draft exists.
      if (nextHead && currentHead && (!body.value || adopt)) currentHead.value = nextHead.value;
    } catch { status.textContent = 'Could not refresh messages. Use Refresh to recover.'; }
    finally { refreshing = false; if (again && !closed) { again = false; const adoptNext = adoptPending; adoptPending = false; refresh(adoptNext); } }
  }
  function command(method, params, request_id = crypto.randomUUID()) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify({ request_id, method, params })); return true;
  }
  function connect() {
    if (closed) return;
    const url = new URL('/chat/v1/ws', location.origin); url.protocol = 'wss:'; url.searchParams.set('offset', offset);
    ws = new WebSocket(url);
    ws.onopen = () => { lastSeen = Date.now(); status.textContent = 'Live'; };
    ws.onmessage = event => {
      lastSeen = Date.now();
      let frame; try { frame = JSON.parse(event.data); } catch { return; }
      if (frame.request_id) {
        if (pending && frame.request_id === pending.request_id) {
          const sent = pending; pending = null; clearTimeout(sendTimeout); form.querySelector('button[type="submit"]').disabled = false;
          if (frame.ok) { sessionStorage.removeItem('chat-send-intent:' + chat.id); if (body.value === sent.text) body.value = ''; refresh(); }
          else { sessionStorage.removeItem('chat-send-intent:' + chat.id); status.textContent = 'Not sent: ' + frame.error.code + '. Review messages before submitting again.'; refresh(frame.error.code === 'stale_view'); }
        }
        return;
      }
      if (!frame.ok) {
        if (frame.error && ['offset_expired', 'invalid_offset'].includes(frame.error.code)) {
          status.textContent = 'Expired · Refresh'; stop(false);
        }
        return;
      }
      if (!frame.result || !Array.isArray(frame.result.updates)) return;
      for (const update of frame.result.updates) {
        if (update.chat.id !== chat.id) continue;
        if (['message', 'edit', 'retract', 'membership'].includes(update.type)) refresh();
        if (['typing', 'presence'].includes(update.type)) {
          const d = update.data, key = update.type + ':' + d.identity_id;
          transient.delete(key);
          if ((update.type === 'typing' ? d.active : d.status !== 'offline' && !d.stale) && d.expires_at > Date.now())
            transient.set(key, { expires: d.expires_at, text: d.identity_id + (update.type === 'typing' ? ' is typing' : ' is ' + d.status) });
        }
      }
      offset = frame.result.next_offset; renderSignals();
    };
    ws.onclose = () => {
      transient.clear(); renderSignals();
      if (pending) { clearTimeout(sendTimeout); pending = null; form.querySelector('button[type="submit"]').disabled = false; status.textContent = 'Send outcome unknown. Draft kept; reconcile before resending.'; }
      else if (!closed) status.textContent = 'Reconnecting…';
      if (!closed) reconnect = setTimeout(connect, 2000 + Math.random() * 3000);
    };
    ws.onerror = () => ws.close();
  }
  function typing() {
    if (Date.now() - typingAt < 3000) return;
    typingAt = Date.now(); command('sendTyping', { chat, active: !!body.value, client_id: crypto.randomUUID() });
  }
  function submit(event) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return; // ordinary server form fallback
    event.preventDefault(); if (pending) return;
    pending = { request_id: crypto.randomUUID(), text: body.value,
      params: { chat, text: body.value, after: Number(form.querySelector('[name="after"]').value), client_id: crypto.randomUUID() } };
    // Retain exact intent before delivery, including when the reply is lost.
    try { sessionStorage.setItem('chat-send-intent:' + chat.id, JSON.stringify(pending)); }
    catch { pending = null; status.textContent = 'Not sent: intent storage unavailable. Use the ordinary form after disconnecting.'; return; }
    form.querySelector('button[type="submit"]').disabled = true;
    command('sendMessage', pending.params, pending.request_id);
    sendTimeout = setTimeout(() => {
      if (!pending) return;
      pending = null; form.querySelector('button[type="submit"]').disabled = false;
      status.textContent = 'Send outcome unknown. Draft kept; reconcile before resending.'; refresh();
    }, 15000);
  }
  function stop(clear = true) {
    closed = true; clearTimeout(reconnect); clearTimeout(sendTimeout); clearInterval(heartbeat); clearInterval(expiry);
    if (ws) { ws.onclose = null; ws.close(); }
    if (form) form.removeEventListener('submit', submit);
    if (body) body.removeEventListener('input', typing);
    removeEventListener('pagehide', stop); document.removeEventListener('wb:before-replace', stop);
    if (clear) { transient.clear(); renderSignals(); }
  }
  window.__chatLiveStop = stop;
  addEventListener('pagehide', stop);
  document.addEventListener('wb:before-replace', stop);
  if (body) body.addEventListener('input', typing);
  if (form) form.addEventListener('submit', submit);
  heartbeat = setInterval(() => { if (ws && ws.readyState === WebSocket.OPEN) { if (Date.now() - lastSeen > 90000) ws.close(); else ws.send(JSON.stringify({ type: 'ping' })); } }, 30000);
  expiry = setInterval(renderSignals, 1000);
  connect();
})();`;
