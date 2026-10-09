// Served as a content-hashed external asset. Untrusted names/status are rendered only with textContent.
export const CHAT_PRESENCE_JS = String.raw`(() => {
  const box = document.querySelector('[data-chat-presence]');
  if (!box) return;
  const channel = box.dataset.chatPresence;
  const connection = box.querySelector('[data-presence-connection]');
  const sharing = box.querySelector('[data-presence-sharing]');
  const freshness = box.querySelector('[data-presence-freshness]');
  const list = box.querySelector('[data-presence-list]');
  const toggle = box.querySelector('[data-presence-toggle]');
  let opted = false, pending = false, queued = false, nextStatus = null, stopped = false;
  let entries = [], snapshotAt = 0, observedAt = 0, timer, expiryTimer;
  let generation = 0, snapshotValid = false, frozen = false;
  const requests = new Set();
  function unknown(message) {
    snapshotValid = false; entries = []; list.replaceChildren();
    freshness.textContent = 'No current presence snapshot.';
    connection.textContent = message;
  }
  function invalidate(message) {
    generation++; queued = false; nextStatus = null;
    for (const controller of requests) controller.abort();
    unknown(message);
  }
  function draw() {
    list.replaceChildren();
    if (!snapshotValid) return;
    const elapsed = Math.max(0, performance.now() - snapshotAt);
    // Even explicit offline is only a bounded snapshot, not a permanent directory.
    if (elapsed >= 90000) {
      unknown('Presence snapshot expired. Current status is unknown; refresh will retry.');
      return;
    }
    freshness.textContent = 'Snapshot observed at ' + new Date(observedAt).toISOString() + ' · at least ' + Math.floor(elapsed / 1000) + ' seconds old (including request time).';
    for (const entry of entries) {
      const li = document.createElement('li');
      const expired = elapsed >= Math.max(0, entry.expires_at - observedAt);
      const state = expired && (entry.state === 'online' || entry.state === 'away') ? 'stale' : entry.state;
      li.textContent = '@' + entry.handle + ' · ' + entry.kind + (entry.via_assistant ? ' via-assistant' : '') + ' · ' + state + ' · last heartbeat ' + new Date(entry.last_seen).toISOString();
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
    requests.add(controller);
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetch('/api/' + name, { method: 'POST', credentials: 'same-origin', redirect: 'error',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify(input), signal: controller.signal });
      if (!res.ok) {
        const error = new Error('unavailable');
        error.denied = [401, 403, 404].includes(res.status);
        throw error;
      }
      const body = await res.json();
      if (!body.ok) throw new Error('unavailable');
      return body.result;
    } finally { requests.delete(controller); clearTimeout(timeout); }
  }
  function pauseSharing() {
    opted = false; nextStatus = null;
    toggle.textContent = 'Share presence in this channel';
    sharing.textContent = 'Not sharing. Delivery is uncertain; any accepted heartbeat expires within 90 seconds. Share explicitly again after connection recovers.';
  }
  async function refresh() {
    if (stopped) return;
    if (pending) { queued = true; return; }
    pending = true;
    const startedGeneration = generation;
    let attemptedHeartbeat = false;
    const current = () => !stopped && navigator.onLine && startedGeneration === generation;
    try {
      if (!navigator.onLine) throw new Error('disconnected');
      const status = nextStatus || (opted && !document.hidden ? 'online' : null);
      nextStatus = null;
      if (status) {
        attemptedHeartbeat = true;
        await api('chat.heartbeat', { c: channel, status });
      }
      if (!current()) return;
      // Charge the whole round trip against freshness, conservatively: client clock skew or
      // slow transport must never extend the server's expiry window.
      const requestedAt = performance.now();
      const result = await api('chat.presence', { c: channel });
      if (!current()) return;
      entries = result.entries; observedAt = result.observed_at; snapshotAt = requestedAt; snapshotValid = true;
      connection.textContent = 'Presence snapshot refreshed. Heartbeats expire after 90 seconds; they do not prove reading or work.';
      draw();
    } catch (error) {
      // Stale responses cannot alter a new view, including its sharing/access controls.
      if (stopped || startedGeneration !== generation) return;
      if (error.denied) {
        opted = false; nextStatus = null; toggle.disabled = true;
        toggle.textContent = 'Share presence in this channel';
        sharing.textContent = 'Sharing stopped: sign-in or channel access is unavailable.';
      } else if (attemptedHeartbeat || opted || nextStatus) {
        // Delivery may have succeeded. Never replay a report (including a queued change)
        // from this uncertain participation interval; reconcile by querying until new consent.
        pauseSharing();
      }
      unknown('Disconnected or presence unavailable. Current status is unknown; refresh will retry.');
    } finally {
      pending = false;
      if (queued) { queued = false; refresh(); }
    }
  }
  toggle.addEventListener('click', () => {
    if (stopped || toggle.disabled) return;
    opted = !opted; nextStatus = opted ? (document.hidden ? 'away' : 'online') : 'offline';
    toggle.textContent = opted ? 'Stop sharing presence' : 'Share presence in this channel';
    sharing.textContent = opted ? 'Sharing while this channel is visible; hidden pages stop renewing online status.' : 'Not sharing. If the offline update cannot be delivered, the previous heartbeat expires within 90 seconds.';
    refresh();
  });
  function visibilityChanged() {
    if (opted) nextStatus = document.hidden ? 'away' : 'online';
    refresh();
  }
  function offline() {
    if (stopped) return;
    if (!toggle.disabled) pauseSharing();
    invalidate('Disconnected or presence unavailable. Current status is unknown; refresh will retry.');
  }
  function suspend() {
    stopped = true;
    invalidate('Page suspended. Current status is unknown.');
    clearInterval(timer); clearInterval(expiryTimer);
  }
  function pagehide() {
    frozen = false; // Only persisted pageshow may reactivate a history-suspended page.
    suspend();
  }
  function freeze() {
    if (stopped) return;
    frozen = true;
    suspend();
  }
  function resume() {
    if (!frozen) return;
    frozen = false;
    restore();
  }
  function dispose(event) {
    if (!event.detail || !event.detail.contains(box)) return;
    // Pane navigation is not a pagehide. Stop the old channel client before replacement;
    // abort is ambiguous delivery, so do not claim/send offline or auto-retry a heartbeat.
    pagehide(); opted = false;
    document.removeEventListener('visibilitychange', visibilityChanged);
    document.removeEventListener('freeze', freeze);
    document.removeEventListener('resume', resume);
    document.removeEventListener('wb:before-replace', dispose);
    window.removeEventListener('online', refresh);
    window.removeEventListener('offline', offline);
    window.removeEventListener('pagehide', pagehide);
    window.removeEventListener('pageshow', pageshow);
  }
  document.addEventListener('visibilitychange', visibilityChanged);
  document.addEventListener('freeze', freeze);
  document.addEventListener('resume', resume);
  document.addEventListener('wb:before-replace', dispose);
  window.addEventListener('online', refresh);
  window.addEventListener('offline', offline);
  window.addEventListener('pagehide', pagehide);
  function startTimers() {
    clearInterval(timer); clearInterval(expiryTimer);
    timer = setInterval(refresh, 30000);
    expiryTimer = setInterval(draw, 1000);
  }
  function restore() {
    // Freeze and history restoration are not evidence of uninterrupted participation.
    invalidate('Page restored. Current status is unknown until refreshed.');
    stopped = false; opted = false; nextStatus = null;
    toggle.textContent = 'Share presence in this channel';
    sharing.textContent = 'Not sharing. Share explicitly again after returning to this page.';
    startTimers(); refresh();
  }
  function pageshow(event) {
    if (!event.persisted) return;
    frozen = false;
    restore();
  }
  window.addEventListener('pageshow', pageshow);
  startTimers();
  refresh();
})();`;
