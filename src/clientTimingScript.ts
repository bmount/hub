import { TIMING_NAMES, TIMING_PATHS, timingPath } from "./clientTiming";

export const CLIENT_TIMING_JS = `var timingPath = ${timingPath.toString()};\nvar timingNames = ${JSON.stringify(TIMING_NAMES)};\nvar timingPaths = ${JSON.stringify(TIMING_PATHS)};\n` + String.raw`
(function () {
  var queue = [], interactions = [], flushing = false, current = timingPath(location.href), previous = '/other', pagePath = current, pagePrevious;
  try { if (document.referrer && new URL(document.referrer).origin === location.origin) previous = timingPath(document.referrer); } catch (_) {}
  try { var lastRoute = sessionStorage.getItem('pimwell:timing-route'); if (timingPaths.indexOf(lastRoute) >= 0) previous = lastRoute; } catch (_) {}
  pagePrevious = previous;
  var nativeAction = null;
  try {
    var saved = JSON.parse(sessionStorage.getItem('pimwell:timing-navigation') || 'null'); sessionStorage.removeItem('pimwell:timing-navigation');
    if (saved && timingNames.indexOf(saved.name) >= 0 && Number.isFinite(saved.at) && Date.now() - saved.at >= 0 && Date.now() - saved.at < 60000) nativeAction = {name:saved.name,at:saved.at};
  } catch (_) {}
  var nav = performance.getEntriesByType('navigation')[0];
  var pageId = nav && nav.serverTiming && (nav.serverTiming.find(function (s) { return s.name === 'request'; }) || {}).description || '';
  var currentId = pageId;
  function validId(id) { return typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id); }
  function point(name, phase, duration, id, path, prev) {
    if (!validId(id) || timingNames.indexOf(name) < 0 || !Number.isFinite(duration) || duration < 0) return;
    var p = {path: path || current, previous: prev || previous, name: name, phase: phase, request: id, duration: Math.min(3600000, duration)};
    if (queue.length >= 100 && !flushing) flush();
    if (queue.length < 300) queue.push(p);
    return p;
  }
  function flush() {
    if (flushing) return;
    flushing = true;
    snapshot();
    while (queue.length) {
      var batch = queue.slice(0, 100);
      try { if (!navigator.sendBeacon('/client/timing', new Blob([JSON.stringify(batch)], {type:'application/json'}))) break; } catch (_) { break; }
      queue.splice(0, batch.length);
    }
    flushing = false;
  }
  function mark(root) {
    var selector = '[data-href],form,.jump input,[data-close-inspector],.wb-inline-edit summary,a';
    var elements = Array.from(root.querySelectorAll(selector)); if (root.matches && root.matches(selector)) elements.unshift(root);
    elements.forEach(function (el) {
      if (el.hasAttribute('data-perf')) return;
      var name = el.matches('.jump input') ? 'search' : el.matches('form') ? (el.id === 'ask' ? 'assistant.send' : el.matches('.channel-compose') ? 'chat.send' : 'form.submit') : el.closest('[data-href]') ? (/\/docket$/.test(location.pathname) ? 'docket.select' : 'list.select') : el.matches('.wb-inline-edit summary') ? 'inspector.open' : 'pane.swap';
      el.setAttribute('data-perf', name);
    });
  }
  mark(document);
  new MutationObserver(function (records) { records.forEach(function (r) { r.addedNodes.forEach(function (node) { if (node.nodeType === 1) mark(node); }); }); }).observe(document.body, {childList:true,subtree:true});
  var latest = null;
  function input(event) {
    var el = event.target.closest('[data-perf]');
    if (!el || (event.type === 'input' && el.getAttribute('data-perf') !== 'search')) return;
    var name = el.getAttribute('data-perf'); if (timingNames.indexOf(name) < 0) return;
    var action = {name:name, started:performance.now(), stamp:event.timeStamp, id:currentId, path:current, previous:previous, paint:null};
    latest = action; interactions.push(action); if (interactions.length > 40) interactions.shift();
    // Ordinary same-origin links/uploads still navigate without enhancement.
    // Carry only the allowlisted action and a clock, never its destination/data.
    var form = event.type === 'submit' && event.target, anchor = event.type === 'click' && event.target.closest('a[href]');
    var target = form ? form.action : anchor && !anchor.target && !anchor.hasAttribute('download') ? anchor.href : null;
    if (target && new URL(target, location.href).origin === location.origin && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
      queueMicrotask(function () { if (!event.defaultPrevented) try { sessionStorage.setItem('pimwell:timing-navigation',JSON.stringify({name:name,at:Date.now()})); } catch (_) {} });
    }
    // rAF runs before paint: a task posted from it observes the next painted frame.
    // Event Timing replaces this fallback where the browser supplies it.
    requestAnimationFrame(function () { setTimeout(function () {
      action.paint = point(name, 'paint', performance.now() - action.started, action.id, action.path, action.previous);
    }, 0); });
  }
  ['click','submit','input','keydown'].forEach(function (type) { document.addEventListener(type, function (e) {
    if (type === 'keydown' && !['Enter','ArrowDown','ArrowUp'].includes(e.key)) return;
    input(e);
  }, true); });
  function start(name) {
    var action = latest && (!name || latest.name === name) && performance.now() - latest.started < 1500 ? latest : null;
    return {name:name || (action && action.name) || 'pane.swap', started:performance.now(), id:currentId, path:current, previous:previous, action:action};
  }
  function response(op, res) {
    var id = res.headers.get('x-request-id'); if (!validId(id)) return;
    op.id = id;
    if (op.action) { op.action.id = id; if (op.action.paint) op.action.paint.request = id; }
  }
  function end(op, spinner) {
    point(op.name, 'fetch', performance.now() - op.started, op.id, op.path, op.previous);
    if (spinner) point(op.name, 'spinner', performance.now() - op.started, op.id, op.path, op.previous);
  }
  function navigate(url, op) {
    previous = current; current = timingPath(url); currentId = op.id;
    point('navigation', 'page', performance.now() - op.started, op.id, current, previous);
    var path = current, prev = previous, inspector = document.body.getAttribute('data-focus') === 'inspector';
    requestAnimationFrame(function () { setTimeout(function () {
      point('pane.swap', 'paint', performance.now() - op.started, op.id, path, prev);
      if (inspector) point('inspector.open', 'paint', performance.now() - op.started, op.id, path, prev);
    }, 0); });
  }
  window.pimwellTiming = {start:start, response:response, end:end, navigate:navigate, point:point, id:function () { return currentId; }};
  var lcp = null, cls = 0, clsAt = 0, clsStart = 0, clsWindow = 0, clsChanged = false;
  function observe(type, cb, extra) {
    try { var observer = new PerformanceObserver(function (list) { cb(list.getEntries()); }); observer.observe(Object.assign({type:type,buffered:true},extra || {})); } catch (_) {}
  }
  observe('largest-contentful-paint', function (entries) { lcp = entries[entries.length-1].startTime; });
  observe('layout-shift', function (entries) { entries.forEach(function (e) {
    if (e.hadRecentInput) return;
    if (e.startTime - clsAt > 1000 || e.startTime - clsStart > 5000) { clsWindow = 0; clsStart = e.startTime; }
    clsAt = e.startTime; clsWindow += e.value; cls = Math.max(cls, clsWindow); clsChanged = true;
  }); });
  observe('longtask', function (entries) { entries.forEach(function (e) { point('longtask','page',e.duration,pageId,pagePath,pagePrevious); }); });
  observe('event', function (entries) { entries.forEach(function (e) {
    var action = interactions.find(function (a) { return Math.abs(a.stamp - e.startTime) < 8; });
    if (action && action.paint) action.paint.duration = Math.min(3600000,e.duration);
  }); }, {durationThreshold:16});
  function snapshot() {
    if (lcp !== null) { point('lcp','page',lcp,pageId,pagePath,pagePrevious); lcp = null; }
    if (clsChanged) { point('cls','page',cls,pageId,pagePath,pagePrevious); clsChanged = false; }
  }
  function loaded() {
    setTimeout(function () {
      var n = performance.getEntriesByType('navigation')[0]; if (!n) return;
      [['navigation',n.duration],['dns',n.domainLookupEnd-n.domainLookupStart],['connect',n.connectEnd-n.connectStart],['tls',n.secureConnectionStart ? n.connectEnd-n.secureConnectionStart : 0],['ttfb',n.responseStart-n.requestStart],['response',n.responseEnd-n.responseStart],['dom.interactive',n.domInteractive],['load',n.loadEventEnd]].forEach(function (p) { point(p[0],'page',p[1],pageId,pagePath,pagePrevious); });
      point('cls','page',cls,pageId,pagePath,pagePrevious);
      if (nativeAction) {
        point(nativeAction.name,'fetch',n.responseEnd,pageId,pagePath,pagePrevious);
        requestAnimationFrame(function () { setTimeout(function () { point(nativeAction.name,'paint',Date.now()-nativeAction.at,pageId,pagePath,pagePrevious); },0); });
      }
    }, 0);
  }
  if (document.readyState === 'complete') loaded(); else addEventListener('load',loaded,{once:true});
  addEventListener('pagehide',function () { try { sessionStorage.setItem('pimwell:timing-route',current); } catch (_) {} flush(); });
  addEventListener('pageshow',function (e) { if (e.persisted) {
    try { var route = sessionStorage.getItem('pimwell:timing-route'); if (timingPaths.indexOf(route) >= 0) previous = route; } catch (_) {}
    point('navigation','page',0,currentId);
  } });
  document.addEventListener('visibilitychange',function () { if (document.visibilityState === 'hidden') flush(); });
})();
`;
