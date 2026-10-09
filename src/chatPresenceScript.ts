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
  let entries = [], snapshotAt = null, participationAt = null, observedAt = 0, timer, expiryTimer;
  function clock() { return { monotonic: performance.now(), wall: Date.now() }; }
  function age(since) {
    // Some platforms pause performance.now() during system sleep. Either clock may
    // expire state early; wall-clock rollback must never extend monotonic freshness.
    return Math.max(0, performance.now() - since.monotonic, Date.now() - since.wall);
  }
  let generation = 0, snapshotValid = false, frozen = false, observationAnchor = null;
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
  function expireParticipation() {
    if (stopped || !participationAt || (!opted && !nextStatus) || age(participationAt) < 90000) return;
    pauseSharing();
    invalidate('Sharing interval expired. Current status is unknown until refreshed.');
  }
  function expireSnapshot() {
    // Expiring the directory must also retire its participation interval BEFORE a
    // renewal. A recent heartbeat cannot make an old/replayed snapshot current.
    if (!snapshotValid || age(snapshotAt) < 90000) return;
    if (opted || nextStatus) pauseSharing();
    invalidate('Presence snapshot expired. Current status is unknown; refresh will retry.');
  }
  function draw() {
    expireParticipation();
    expireSnapshot();
    list.replaceChildren();
    if (!snapshotValid) return;
    const elapsed = age(snapshotAt);
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
    const requestedAt = clock();
    let rejectAbort;
    const aborted = new Promise((_, reject) => { rejectAbort = reject; });
    function onAbort() { rejectAbort(new Error('presence request aborted')); }
    controller.signal.addEventListener('abort', onAbort, { once: true });
    const timeout = setTimeout(() => controller.abort(), 8000);
    function timely() {
      // Timers/abort delivery can be delayed by sleep or an event-loop stall. Check
      // the absolute budget after headers AND body, not just the timeout callback.
      if (controller.signal.aborted || age(requestedAt) >= 8000) {
        controller.abort();
        throw new Error('presence request deadline exceeded');
      }
    }
    try {
      // Abort must release refresh even when fetch/body decoding ignores its signal.
      // The losing operation remains observed by race; its late result/denial cannot
      // alter a recovered view or continue the abandoned heartbeat into a query.
      return await Promise.race([aborted, (async () => {
        const res = await fetch('/api/' + name, { method: 'POST', credentials: 'same-origin', redirect: 'error',
          headers: { 'content-type': 'application/json' }, body: JSON.stringify(input), signal: controller.signal });
        // An overdue denial is an obsolete transport result, not a current access
        // verdict. Enforce the budget before interpreting status, just as for body.
        timely();
        if (!res.ok) {
          const error = new Error('unavailable');
          error.denied = [401, 403, 404].includes(res.status);
          throw error;
        }
        const body = await res.json();
        timely();
        if (!body.ok) throw new Error('unavailable');
        return body.result;
      })()]);
    } finally {
      requests.delete(controller); clearTimeout(timeout);
      controller.signal.removeEventListener('abort', onAbort);
    }
  }
  function validateSnapshot(result) {
    // Validate the complete snapshot before assigning or rendering any activity. A
    // stale proxy/wrong-channel response is not evidence about this active channel.
    const timestamp = value => Number.isSafeInteger(value) && value >= 0 && value <= 8640000000000000;
    if (!result || result.channel !== channel || result.missing !== 'unknown' || result.ttl_ms !== 90000 ||
        !timestamp(result.observed_at) || !Array.isArray(result.entries) || result.entries.length > 200) {
      throw new Error('invalid presence snapshot');
    }
    const identities = new Set();
    for (const entry of result.entries) {
      if (!entry || typeof entry.identity_id !== 'string' || !entry.identity_id || identities.has(entry.identity_id) ||
          typeof entry.handle !== 'string' || typeof entry.display_name !== 'string' ||
          !['human', 'agent'].includes(entry.kind) || typeof entry.via_assistant !== 'boolean' ||
          !['online', 'away', 'offline', 'stale'].includes(entry.state) ||
          !timestamp(entry.last_seen) || !timestamp(entry.expires_at) || entry.last_seen > result.observed_at ||
          entry.expires_at < entry.last_seen || (entry.state !== 'offline' && entry.expires_at === entry.last_seen) ||
          entry.expires_at - entry.last_seen > result.ttl_ms ||
          (['online', 'away'].includes(entry.state) && entry.expires_at <= result.observed_at) ||
          (entry.state === 'stale' && entry.expires_at > result.observed_at)) {
        throw new Error('invalid presence entry');
      }
      identities.add(entry.identity_id);
    }
    return result;
  }
  function pauseSharing() {
    opted = false; queued = false; nextStatus = null; participationAt = null;
    toggle.textContent = 'Share presence in this channel';
    sharing.textContent = 'Not sharing. Delivery is uncertain; any accepted heartbeat expires within 90 seconds. Share explicitly again after connection recovers.';
  }
  async function refresh() {
    if (stopped) return;
    // Check before a renewal, not only in the expiry timer: both timers can be delayed.
    expireParticipation();
    expireSnapshot();
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
        participationAt = clock(); // Query-only refreshes never prolong participation.
        await api('chat.heartbeat', { c: channel, status });
      }
      if (!current()) return;
      // Charge the whole round trip against freshness, conservatively: client clock skew or
      // slow transport must never extend the server's expiry window.
      const requestedAt = clock();
      const result = await api('chat.presence', { c: channel });
      if (!current()) return;
      validateSnapshot(result);
      // A repeated observation cannot restart freshness. Keep this anchor through
      // unknown/suspension/recovery; only a newer authoritative observation gets a
      // new age. Server clock rollback fails conservatively, not green.
      if (observationAnchor && result.observed_at < observationAnchor.observed) {
        throw new Error('regressed presence observation');
      }
      const elapsed = Math.max(age(requestedAt), observationAnchor &&
        result.observed_at === observationAnchor.observed ? age(observationAnchor.at) : 0);
      if (elapsed >= 90000) throw new Error('expired presence observation');
      const acceptedAt = clock();
      acceptedAt.monotonic -= elapsed; acceptedAt.wall -= elapsed;
      observationAnchor = { observed: result.observed_at, at: acceptedAt };
      entries = result.entries; observedAt = result.observed_at; snapshotAt = acceptedAt; snapshotValid = true;
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
    // Retire stale state before installing new consent, but preserve the button's
    // displayed intent: a Stop click must never turn into renewed online sharing.
    const startSharing = !opted;
    expireSnapshot();
    opted = startSharing; nextStatus = opted ? (document.hidden ? 'away' : 'online') : 'offline';
    participationAt = clock(); // A new explicit action is fresh consent, not a timer retry.
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
    stopped = false; opted = false; nextStatus = null; participationAt = null;
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
