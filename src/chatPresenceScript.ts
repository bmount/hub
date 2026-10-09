// Served as a content-hashed external asset. Untrusted names/status are rendered only with textContent.
export const CHAT_PRESENCE_JS = String.raw`(() => {
  const box = document.querySelector('[data-chat-presence]');
  if (!box) return;
  const channel = box.dataset.chatPresence;
  const connection = box.querySelector('[data-presence-connection]');
  const sharing = box.querySelector('[data-presence-sharing]');
  const list = box.querySelector('[data-presence-list]');
  const toggle = box.querySelector('[data-presence-toggle]');
  let opted = false, pending = false, queued = false, nextStatus = null, stopped = false;
  let entries = [], snapshotAt = 0, observedAt = 0, timer, expiryTimer;
  function draw() {
    list.replaceChildren();
    const elapsed = performance.now() - snapshotAt;
    for (const entry of entries) {
      const li = document.createElement('li');
      const expired = elapsed >= Math.max(0, entry.expires_at - observedAt);
      const state = expired && (entry.state === 'online' || entry.state === 'away') ? 'stale' : entry.state;
      li.textContent = '@' + entry.handle + ' · ' + entry.kind + ' · ' + state + ' · last heartbeat ' + new Date(entry.last_seen).toISOString();
      list.append(li);
    }
    if (!entries.length) {
      const li = document.createElement('li');
      li.textContent = 'No recent explicit heartbeats. Presence is unknown.';
      list.append(li);
    }
  }
  async function api(name, input) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetch('/api/' + name, { method: 'POST', credentials: 'same-origin', redirect: 'error',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify(input), signal: controller.signal });
      if (!res.ok) {
        if ([401, 403, 404].includes(res.status)) {
          opted = false; nextStatus = null; toggle.disabled = true;
          sharing.textContent = 'Sharing stopped: sign-in or channel access is unavailable.';
        }
        throw new Error('unavailable');
      }
      const body = await res.json();
      if (!body.ok) throw new Error('unavailable');
      return body.result;
    } finally { clearTimeout(timeout); }
  }
  async function refresh() {
    if (stopped) return;
    if (pending) { queued = true; return; }
    pending = true;
    try {
      if (!navigator.onLine) throw new Error('disconnected');
      const status = nextStatus || (opted && !document.hidden ? 'online' : null);
      nextStatus = null;
      if (status) await api('chat.heartbeat', { c: channel, status });
      // Charge the whole round trip against freshness, conservatively: client clock skew or
      // slow transport must never extend the server's expiry window.
      const requestedAt = performance.now();
      const result = await api('chat.presence', { c: channel });
      entries = result.entries; observedAt = result.observed_at; snapshotAt = requestedAt;
      connection.textContent = 'Presence snapshot refreshed. Heartbeats expire after 90 seconds; they do not prove reading or work.';
      draw();
    } catch (_) {
      // Never keep green-looking cached entries or names after disconnection/access denial.
      entries = []; list.replaceChildren();
      connection.textContent = 'Disconnected or presence unavailable. Current status is unknown; refresh will retry.';
    } finally {
      pending = false;
      if (queued) { queued = false; refresh(); }
    }
  }
  toggle.addEventListener('click', () => {
    opted = !opted; nextStatus = opted ? (document.hidden ? 'away' : 'online') : 'offline';
    toggle.textContent = opted ? 'Stop sharing presence' : 'Share presence in this channel';
    sharing.textContent = opted ? 'Sharing while this channel is visible; hidden pages stop renewing online status.' : 'Not sharing. If the offline update cannot be delivered, the previous heartbeat expires within 90 seconds.';
    refresh();
  });
  document.addEventListener('visibilitychange', () => {
    if (opted) nextStatus = document.hidden ? 'away' : 'online';
    refresh();
  });
  window.addEventListener('online', refresh);
  window.addEventListener('offline', refresh);
  window.addEventListener('pagehide', () => { stopped = true; clearInterval(timer); clearInterval(expiryTimer); });
  function startTimers() {
    timer = setInterval(refresh, 30000);
    expiryTimer = setInterval(draw, 1000);
  }
  window.addEventListener('pageshow', (event) => {
    if (!event.persisted) return;
    // A back/forward-cache restore is a new view, not evidence of uninterrupted presence.
    stopped = false; opted = false; nextStatus = null; entries = []; list.replaceChildren();
    toggle.textContent = 'Share presence in this channel';
    sharing.textContent = 'Not sharing. Share explicitly again after returning to this page.';
    startTimers(); refresh();
  });
  startTimers();
  refresh();
})();`;
