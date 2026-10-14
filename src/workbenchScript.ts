// The workbench's only script: progressive enhancement over pages that already work without it.
// - Links and forms inside the workbench fetch the next page and swap only the panes that changed (a pane keeps its
//   place when its data-key is the same), so the list keeps its scroll while the inspector changes.
// - Keyboard: ⌘K or Ctrl+K jump, j and k move through the list, Enter opens, e edits, c files, / filters, Esc closes.
// - The status bar shows the server's own timing for the last page (Server-Timing).
// Written without template literals so it can live in a TypeScript string.
import { timeText } from "./html";
export const WORKBENCH_JS = `var timeText = ${timeText.toString()};\n` + String.raw`
(function () {
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  function timing(st) {
    var el = $("#perf"); if (!el || !st) return;
    var app = /app;dur=(\d+)/.exec(st), db = /(\d+) round trips/.exec(st);
    el.textContent = (db ? db[1] + " trips · " : "") + (app ? app[1] + " ms" : "");
  }
  try {
    var nav = performance.getEntriesByType("navigation")[0];
    if (nav && nav.serverTiming) timing(nav.serverTiming.map(function (t) { return t.name + ";dur=" + t.duration + (t.description ? ';desc="' + t.description + '"' : ""); }).join(", "));
  } catch (e) {}

  function markSelected() {
    var here = new URL(location.href); here.searchParams.sort();
    $$("#list [data-href]").forEach(function (r) {
      var target = new URL(r.getAttribute("data-href"), location.href); target.searchParams.sort();
      r.setAttribute("aria-selected", target.pathname === here.pathname && target.search === here.search ? "true" : "false");
    });
    var label = {"#feature-knowledge": "Knowledge base", "#project-research": "Research", "#deploys": "Deploys"}[location.hash];
    var crumb = $(".bar .wb-breadcrumb ol");
    if (crumb && label && !$("[data-fragment]", crumb)) {
      $$("[aria-current]", crumb).forEach(function (a) { a.removeAttribute("aria-current"); });
      var li = document.createElement("li"), a = document.createElement("a"); li.setAttribute("data-fragment", "1"); a.href = location.pathname + location.search + location.hash; a.textContent = label; a.setAttribute("aria-current", "page"); li.appendChild(a); crumb.appendChild(li);
    }
  }
  function closeRail() { ["#rail", "#explorer"].forEach(function (id) { var r = $(id); if (r) r.classList.remove("open"); }); if (location.hash === "#rail" || location.hash === "#explorer") history.replaceState(history.state, "", location.pathname + location.search); }
  function explorerKey(el) { return "wb:explorer:" + el.getAttribute("data-preference") + ":" + el.getAttribute("data-project"); }
  function branchKey(el) { var s = $("summary", el), a = s && $("a", s); if (a) { var url = new URL(a.href, location.href); return url.pathname + url.search + url.hash; } return s ? s.textContent : ""; }
  function saveExplorer(el) {
    if (!el) return;
    var branches = {}; $$("details", el).forEach(function (d) { branches[branchKey(d)] = d.open; });
    try { sessionStorage.setItem(explorerKey(el), JSON.stringify({top: el.scrollTop, branches: branches})); } catch (e) {}
  }
  function restoreExplorer(el) {
    if (!el) return;
    try {
      var state = JSON.parse(sessionStorage.getItem(explorerKey(el)) || "null");
      if (state) { $$("details", el).forEach(function (d) { var key = branchKey(d); if (!new URL(key, location.href).searchParams.has("repo") && Object.prototype.hasOwnProperty.call(state.branches, key)) d.open = state.branches[key]; }); el.scrollTop = state.top; }
    } catch (e) {}
    if (el.getAttribute("data-in-project") === "1") document.cookie = "pmw_project=" + encodeURIComponent(el.getAttribute("data-preference") + ":" + el.getAttribute("data-project")) + "; Path=/; SameSite=Lax; Secure";
  }
  var WIDTH_KEY = "wb:inspector-width:" + location.host + ":" + ($(".bar .me") || {}).textContent;
  function inspectorWidth(width) {
    width = Math.max(360, Math.min(620, width));
    document.documentElement.style.setProperty("--inspector-width", width + "px");
    try { localStorage.setItem(WIDTH_KEY, String(width)); } catch (e) {}
  }
  try { inspectorWidth(Number(localStorage.getItem(WIDTH_KEY)) || 390); } catch (e) {}
  document.addEventListener("pointerdown", function (e) {
    if (!e.target.matches(".wb-resizer")) return;
    var handle = e.target, start = e.clientX, width = $("#inspector").getBoundingClientRect().width;
    handle.setPointerCapture(e.pointerId);
    function drag(ev) { inspectorWidth(width + start - ev.clientX); }
    function stop() { handle.removeEventListener("pointermove", drag); handle.removeEventListener("pointerup", stop); handle.removeEventListener("pointercancel", stop); }
    handle.addEventListener("pointermove", drag); handle.addEventListener("pointerup", stop); handle.addEventListener("pointercancel", stop);
  });
  document.addEventListener("keydown", function (e) {
    if (!e.target.matches(".wb-resizer") || !/^Arrow(Left|Right)$/.test(e.key)) return;
    e.preventDefault(); inspectorWidth($("#inspector").getBoundingClientRect().width + (e.key === "ArrowLeft" ? 20 : -20));
  });
  function closeInspector() {
    var back = $("#inspector .back"); if (!back) return;
    var url = new URL(back.href), filter = new URL(location.href).searchParams.get("filter");
    if (filter) url.searchParams.set("filter", filter);
    go(url.href);
  }
  document.addEventListener("click", function (e) { if (e.target.closest("[data-close-inspector]")) closeInspector(); });
  function sidebarKey() { var el = $("#explorer"); return "wb:sidebar:" + (el ? el.getAttribute("data-preference") : ""); }
  function sidebarState(collapsed) {
    document.body.classList.toggle("sidebar-collapsed", collapsed);
    var button = $("[data-toggle-sidebar]");
    if (button) { button.setAttribute("aria-expanded", String(!collapsed)); button.setAttribute("aria-label", collapsed ? "Expand sidebar" : "Collapse sidebar"); }
  }
  try { sidebarState(localStorage.getItem(sidebarKey()) === "collapsed"); } catch (e) {}
  document.addEventListener("click", function (e) {
    var toggle = e.target.closest("[data-toggle-sidebar]");
    if (toggle) {
      if (innerWidth < 1280) { var rail = $("#rail"); rail.classList.toggle("open"); return; }
      var collapsed = !document.body.classList.contains("sidebar-collapsed"); sidebarState(collapsed);
      try { localStorage.setItem(sidebarKey(), collapsed ? "collapsed" : "expanded"); } catch (e) {}
    }
    var value = e.target.closest(".wb-inline-edit summary");
    if (value && !e.target.closest("a")) { e.preventDefault(); var details = value.parentElement; details.open = true; var input = $("input:not([type=hidden]),select,textarea,button", details); if (input) input.focus(); else $("summary", details).focus(); }
  });
  document.addEventListener("keydown", function (e) {
    var details = e.target.closest(".wb-inline-edit"); if (!details || !details.open) return;
    if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); var form = $("form", details); if (form) form.reset(); details.open = false; $("summary", details).focus(); }
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); var form = $("form", details); if (form) form.requestSubmit(); }
  });
  restoreExplorer($("#explorer"));
  document.addEventListener("toggle", function (e) { if (e.target.closest("#explorer")) saveExplorer($("#explorer")); }, true);
  addEventListener("pagehide", function () { saveExplorer($("#explorer")); });
  document.addEventListener("input", function (e) {
    if (e.target.id !== "project-filter") return;
    var query = e.target.value.toLowerCase(), chooser = $('[aria-label="Other projects"]', $("#explorer"));
    if (!chooser) return;
    $$("li", chooser).forEach(function (li) { li.hidden = li.textContent.toLowerCase().indexOf(query) < 0; });
  });

  // Parsed panes are inert. Revive only our static pane clients, never inline or arbitrary source scripts.
  function revive(root) {
    $$("script", root).forEach(function (old) {
      var src = old.getAttribute("src"), url = src && new URL(src, location.href);
      if (!url || url.origin !== location.origin || url.search || url.hash || !/^\/assets\/(assistant|playground|presence|chatlive|copy|contactgraph)\.[a-z0-9]+\.js$/.test(url.pathname)) { old.remove(); return; }
      var s = document.createElement("script");
      s.src = url.href;
      old.replaceWith(s);
    });
  }

  function listStateKey(el) { return "wb:list:" + WIDTH_KEY + ":" + el.getAttribute("data-key"); }
  function saveList() {
    var el = $("#list"); if (!el) return;
    try { sessionStorage.setItem(listStateKey(el), JSON.stringify({top: el.scrollTop, checked: $$("input[form=bulk]:checked", el).map(function (i) { return i.value; })})); } catch (e) {}
  }
  function restoreList() {
    var el = $("#list"); if (!el) return;
    try { var state = JSON.parse(sessionStorage.getItem(listStateKey(el)) || "null"); if (state) { el.scrollTop = state.top; $$("input[form=bulk]", el).forEach(function (i) { i.checked = state.checked.indexOf(i.value) >= 0; }); } } catch (e) {}
  }
  addEventListener("pagehide", saveList);
  function swap(doc, url, push, refreshList) {
    var cur = $("main.panes"), next = doc.querySelector("main.panes");
    if (!cur || !next) { location.href = url; return; }
    var me = $(".bar .me"), nme = doc.querySelector(".bar .me");
    // Another tab can switch the shared cookie. Don't retain the old account's panes or header.
    if (!me || !nme || me.textContent !== nme.textContent) { location.href = url; return; }
    saveList();
    ["list", "inspector"].forEach(function (id) {
      var a = document.getElementById(id), b = doc.getElementById(id);
      // Generic one-pane pages have a title key, not a content revision. Search,
      // refresh, same-channel posts and stale drafts must replace them even when
      // the title is unchanged. Only explicitly keyed two-pane lists keep state.
      var key = b && b.getAttribute("data-key") || "";
      // Switching the Assistant phone pane is presentation only: keep its unsent draft and transcript.
      var assistantFocusOnly = id === "inspector" && key.indexOf("assistant:") === 0 && a && a.getAttribute("data-key") === key && !refreshList && doc.body.getAttribute("data-focus") !== document.body.getAttribute("data-focus");
      if (a && b && !assistantFocusOnly && (key.indexOf("page:") === 0 || a.getAttribute("data-key") !== key || id === "inspector" || refreshList)) {
        // Enhanced pane clients must stop timers/listeners before their DOM is detached.
        document.dispatchEvent(new CustomEvent("wb:before-replace", { detail: a }));
        a.replaceWith(b); revive(b); voiceUp(b); localTimes(b);
      }
    });
    cur.className = next.className;
    var rail = $("#rail"), nrail = doc.getElementById("rail");
    if (rail && nrail) { var places = $("#org-places", rail), nextPlaces = doc.getElementById("org-places"); if (places && nextPlaces) places.innerHTML = nextPlaces.innerHTML; }
    var explorer = $("#explorer"), nexplorer = doc.getElementById("explorer");
    if (explorer && nexplorer) {
      saveExplorer(explorer); explorer.innerHTML = nexplorer.innerHTML;
      ["data-project", "data-in-project", "data-preference"].forEach(function (a) { explorer.setAttribute(a, nexplorer.getAttribute(a) || ""); });
      restoreExplorer(explorer);
    }
    var crumb = $(".bar .wb-breadcrumb"), ncrumb = doc.querySelector(".bar .wb-breadcrumb"); if (crumb && ncrumb) crumb.replaceWith(ncrumb);
    var file = $(".bar .file"), nfile = doc.querySelector(".bar .file");
    if (file && nfile) file.replaceWith(nfile); else if (file) file.remove(); else if (nfile) me.before(nfile);
    var search = $(".jump input"), nsearch = doc.querySelector(".jump input"); if (search && nsearch) search.value = nsearch.value;
    var tabs = $(".tabs"), ntabs = doc.querySelector(".tabs"); if (tabs && ntabs) tabs.innerHTML = ntabs.innerHTML;
    var connection = $("#connection-state"); if (connection && !document.querySelector("[data-chat-live]")) connection.replaceChildren();
    document.body.setAttribute("data-focus", doc.body.getAttribute("data-focus") || "list");
    document.title = doc.title;
    if (push) history.pushState({ wb: 1 }, "", url); else history.replaceState({ wb: 1 }, "", url);
    closeRail(); applyFilter(); markSelected(); restoreList();
    var fragment = new URL(url, location.href).hash.slice(1), target = fragment && document.getElementById(fragment); if (target && target.closest("main.panes")) target.scrollIntoView({block: "start"});
    var ins = $("#inspector"); if (ins && document.body.getAttribute("data-focus") === "inspector") ins.scrollTop = 0;
  }

  function ambiguous() {
    var note = $("#wb-ambiguous");
    if (!note) {
      note = document.createElement("p"); note.id = "wb-ambiguous"; note.className = "lede";
      note.setAttribute("role", "alert"); document.body.prepend(note);
    }
    note.textContent = "Outcome unknown: your change may have been saved, but its response could not be displayed. Check the current page before choosing to submit again; retrying may duplicate the change.";
  }

  function pathTemplate(url) {
    var p = new URL(url, location.href).pathname;
    if (/^\/(docket|people|apps|jump|search|assistant|do|new|attention)$/.test(p) || p === "/") return p;
    if (/^\/api\//.test(p)) return "/api/:verb";
    if (/^\/voice\//.test(p)) return "/voice/:operation";
    if (/^\/c\//.test(p)) return "/c/:channel";
    if (/^\/[^/]+\/w\/\d+$/.test(p)) return "/:project/w/:number";
    if (/^\/[^/]+\/docket$/.test(p)) return "/:project/docket";
    if (/^\/[^/]+$/.test(p)) return "/:project";
    return "/other";
  }
  var reports = 0;
  function report(url, duration, phase, result, status) {
    if (++reports > 30) return;
    var controller = new AbortController(), timer = setTimeout(function () { controller.abort(); }, 3000);
    // Telemetry is independent of navigation, never recursively instrumented, and contains only fixed labels.
    fetch("/client/slow", { method: "POST", credentials: "same-origin", signal: controller.signal,
      headers: { "content-type": "application/json", "x-pimwell-client": "1" },
      body: JSON.stringify({ path: pathTemplate(url), duration: Math.min(3600000, Math.round(duration)), phase: phase, result: result, status: status || null })
    }).catch(function () {}).finally(function () { clearTimeout(timer); });
  }
  function request(url, init, read) {
    init = init || {};
    var controller = init.controller || new AbortController(); delete init.controller;
    init.signal = controller.signal;
    var perfOp = init.perfOp || window.pimwellTiming.start(); delete init.perfOp;
    var started = performance.now(), phase = "headers", status = null, timedOut = false, rejectWait;
    var stop = new Promise(function (_, reject) { rejectWait = reject; });
    function aborted() { rejectWait(new Error("Request aborted")); }
    controller.signal.addEventListener("abort", aborted, { once: true });
    var timer = setTimeout(function () { timedOut = true; controller.abort(); }, 15000);
    function check() {
      if (performance.now() - started >= 15000) { timedOut = true; controller.abort(); }
      if (controller.signal.aborted) throw new Error("Request aborted");
    }
    var operation = fetch(url, init).then(function (res) {
      window.pimwellTiming.response(perfOp, res);
      check(); status = res.status; phase = "body";
      return read(res, function (next) { check(); phase = next; });
    }).then(function (value) { check(); return value; });
    return Promise.race([operation, stop]).then(function (value) {
      var duration = performance.now() - started;
      if (duration > 3000 || status >= 400) report(url, duration, phase, status >= 400 ? "failure" : "slow", status);
      return value;
    }, function (error) {
      if (timedOut || !controller.signal.aborted) report(url, performance.now() - started, phase, timedOut ? "timeout" : "failure", status);
      throw error;
    }).finally(function () { window.pimwellTiming.end(perfOp, !!perfOp.spinner); clearTimeout(timer); controller.signal.removeEventListener("abort", aborted); });
  }
  function navigationNotice(url, failed) {
    var note = $("#wb-navigation");
    if (!note) { note = document.createElement("p"); note.id = "wb-navigation"; note.className = "lede"; note.setAttribute("role", "status"); document.body.prepend(note); }
    note.textContent = failed ? "Could not load this page. " : "Taking longer than usual. ";
    var retry = document.createElement("button"); retry.type = "button"; retry.textContent = "Retry";
    retry.onclick = function () { go(url); }; note.appendChild(retry);
  }
  try {
    var entry = performance.getEntriesByType("navigation")[0];
    if (entry && entry.duration > 3000) report(location.href, entry.duration, "navigation", "slow", entry.responseStatus);
    else window.addEventListener("load", function () { setTimeout(function () { var n = performance.getEntriesByType("navigation")[0]; if (n && n.duration > 3000) report(location.href, n.duration, "navigation", "slow", n.responseStatus); }, 0); }, { once: true });
  } catch (e) {}

  var busy = 0, activeNavigation = null;
  function go(url, opts) {
    opts = opts || {};
    var init = { method: opts.method || "GET", credentials: "same-origin", headers: { "x-workbench": "1" } };
    if (opts.body) { init.body = opts.body; init.headers["content-type"] = "application/x-www-form-urlencoded"; }
    var perfOp = window.pimwellTiming.start(); perfOp.spinner = true; init.perfOp = perfOp;
    var mine = ++busy;
    clearTimeout(timer); if (searchController) { searchController.abort(); searchController = null; }
    if (activeNavigation) activeNavigation.abort();
    var controller = new AbortController(); activeNavigation = controller; init.controller = controller;
    var oldNotice = $("#wb-navigation"); if (oldNotice) oldNotice.remove();
    document.body.style.cursor = "progress";
    var started = performance.now(), phase = "headers", status = null;
    var slowTimer = setTimeout(function () { if (mine === busy && init.method === "GET") navigationNotice(url, false); }, 3000);
    var spinnerTimer = setTimeout(function () { if (mine === busy) report(url, performance.now() - started, "spinner", "slow", status); }, 10000);
    return request(url, init, function (res, changePhase) {
      status = res.status; phase = "body";
      timing(res.headers.get("server-timing"));
      return res.text().then(function (html) {
        if (mine !== busy || controller.signal.aborted) return;
        window.pimwellTiming.body(perfOp);
        phase = "render"; changePhase("render");
        var doc = new DOMParser().parseFromString(html, "text/html");
        if (!doc.body || !doc.body.classList.contains("wb")) {
          if (init.method === "GET") { location.href = url; return; }
          var ins = $("#inspector"), main = doc.querySelector("main");
          $("main.panes").classList.remove("one");
          ins.innerHTML = main ? main.innerHTML : html; document.body.setAttribute("data-focus", "inspector"); return;
        }
        var destination = new URL(res.url || url, location.href); destination.hash = new URL(url, location.href).hash;
        swap(doc, destination.href, opts.push !== false, init.method !== "GET");
        window.pimwellTiming.navigate(destination.href, perfOp);
      });
    }).then(function () { if (mine === busy) { var note = $("#wb-navigation"); if (note) note.remove(); } })
      .catch(function () { if (init.method !== "GET") ambiguous(); else if (mine === busy) navigationNotice(url, true); })
      .finally(function () {
        clearTimeout(slowTimer); clearTimeout(spinnerTimer);
        if (mine === busy) { document.body.style.cursor = ""; activeNavigation = null; }
      });
  }

  function local(a) {
    if (!a || a.target || a.hasAttribute("download") || a.getAttribute("data-reload") !== null) return false;
    var href = a.getAttribute("href") || "";
    if (href.charAt(0) === "#" || /^(mailto|tel|javascript):/.test(href)) return false;
    var u = new URL(a.href, location.href);
    if (u.origin !== location.origin) return false;
    return !/^\/(api|mcp|login|logout|oauth|auth|invite)\b/.test(u.pathname) && !/\.git(\/|$)/.test(u.pathname);
  }
  document.addEventListener("click", function (e) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var a = e.target.closest("a");
    if (a && (a.getAttribute("href") === "#rail" || a.getAttribute("href") === "#explorer")) { e.preventDefault(); var r = $(a.getAttribute("href")), wasOpen = r && r.classList.contains("open"); closeRail(); if (r && !wasOpen) r.classList.add("open"); return; }
    if (a && (a.classList.contains("close") || a.classList.contains("scrim"))) { e.preventDefault(); closeRail(); return; }
    if (!a) { var row = e.target.closest("[data-href]"); if (row && !e.target.closest("input,select,textarea,button,form")) { e.preventDefault(); go(row.getAttribute("data-href")); } return; }
    if (local(a)) { e.preventDefault(); go(a.href); }
  });
  // Touch: with the menu open, it follows a finger dragged left and closes past a third of its width (or on a quick
  // flick). On a phone, swiping right across an open item goes back to the list. Starts near the screen's left edge
  // are left to the browser's own back gesture.
  var touch = null;
  document.addEventListener("touchstart", function (e) {
    if (e.touches.length !== 1) { touch = null; return; }
    var t = e.touches[0], r = $(".rail.open, .explorer.open, .rail:target, .explorer:target");
    touch = { x: t.clientX, y: t.clientY, at: Date.now(), open: !!r, drawer: r, axis: null, dx: 0 };
  }, { passive: true });
  document.addEventListener("touchmove", function (e) {
    if (!touch) return;
    var t = e.touches[0], dx = t.clientX - touch.x, dy = t.clientY - touch.y;
    if (!touch.axis && (Math.abs(dx) > 10 || Math.abs(dy) > 10)) touch.axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
    touch.dx = dx;
    if (touch.open && touch.axis === "x") { var r = touch.drawer; r.style.transition = "none"; r.style.transform = "translateX(" + Math.min(0, dx) + "px)"; }
  }, { passive: true });
  document.addEventListener("touchend", function () {
    if (!touch) return;
    var t = touch; touch = null;
    var r = t.drawer;
    if (t.open && r) {
      r.style.transition = ""; r.style.transform = "";
      var fast = t.dx < -40 && Date.now() - t.at < 250;
      if (t.axis === "x" && (t.dx < -r.offsetWidth / 3 || fast)) closeRail();
      return;
    }
    if (t.axis === "x" && t.dx > 80 && t.x > 30 && innerWidth <= 760 && document.body.getAttribute("data-focus") === "inspector") {
      var back = $("#inspector .back"); if (back) go(back.href);
    }
  });

  // Forms marked data-inline submit in place (JSON to the API) and leave everything around them alone: filing one
  // proposal keeps the others on screen. Without the script they post normally.
  function inline(f) {
    var body = {}; new FormData(f).forEach(function (v, k) { if (k.charAt(0) !== "_") body[k] = v; });
    var btn = f.querySelector("button[type=submit]"); if (btn) btn.disabled = true;
    var perfOp = window.pimwellTiming.start("form.submit"); perfOp.spinner = !!btn;
    request(f.getAttribute("action"), { perfOp: perfOp, method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(body) }, function (r) { return r.json(); })
      .then(function (j) {
        var note = document.createElement("p"); note.className = "lede";
        if (j.ok) {
          var ref = j.result && j.result.ref, m = ref && /^([a-z0-9-]+)#(\d+)$/.exec(ref);
          note.textContent = "Done. ";
          if (m) { var a = document.createElement("a"); a.href = "/" + m[1] + "/w/" + m[2]; a.textContent = "Filed " + ref; note.textContent = ""; note.appendChild(a); }
          f.replaceWith(note);
        } else { note.textContent = "Not done: " + (j.detail || j.error); f.appendChild(note); if (btn) btn.disabled = false; }
      }).catch(function () { if (btn) btn.disabled = false; ambiguous(); });
  }
  document.addEventListener("submit", function (e) {
    var f = e.target;
    // Native submission preserves file bytes; URLSearchParams cannot encode multipart bodies.
    var encoding = e.submitter && e.submitter.getAttribute("formenctype") || f.enctype;
    if (e.defaultPrevented || f.getAttribute("data-reload") !== null || encoding === "multipart/form-data") return;
    if (f.hasAttribute("data-inline")) { e.preventDefault(); inline(f); return; }
    var u = new URL(f.getAttribute("action") || location.href, location.href);
    if (u.origin !== location.origin || /^\/(login|logout|oauth|auth|invite)\b/.test(u.pathname)) return;
    e.preventDefault();
    // Include the button that was pressed: forms like Approve / Ask for changes carry their choice on it.
    var data = new URLSearchParams(e.submitter ? new FormData(f, e.submitter) : new FormData(f));
    var filter = new URL(location.href).searchParams.get("filter");
    if (filter && data.has("_back")) { var back = new URL(data.get("_back"), location.href); if (back.origin === location.origin) { back.searchParams.set("filter", filter); data.set("_back", back.pathname + back.search + back.hash); } }
    // A failed response does not mean the mutation failed. Never automatically replay a POST.
    if ((f.getAttribute("method") || "get").toLowerCase() === "post") go(u.href, { method: "POST", body: data });
    else { u.search = data.toString(); go(u.href); }
  });
  var filterTimer;
  document.addEventListener("input", function (e) {
    var f = e.target.form;
    if (f && f.closest(".wb-filters") && (f.getAttribute("method") || "get").toLowerCase() === "get" && e.target.matches("input:not([data-filter]):not([type=hidden])")) {
      clearTimeout(filterTimer); filterTimer = setTimeout(function () { if (f.isConnected) f.requestSubmit(); }, 400);
    }
  });
  document.addEventListener("change", function (e) {
    clearTimeout(filterTimer);
    var f = e.target.form;
    if (f && f.closest(".wb-filters,.filters") && (f.getAttribute("method") || "get").toLowerCase() === "get" && !e.target.matches("[data-filter]")) f.requestSubmit();
  });
  window.addEventListener("popstate", function () { go(location.href, { push: false }); });

  // Jump palette. Focus opens likely places at once (recent picks from this browser, then the record's suggestions:
  // sections, your open work, active projects), so most jumps are one tap. Typing narrows them instantly, word by
  // word, and the full search fills in behind.
  var jump = $(".jump input"), list = null, picks = [], at = -1, timer = 0, sugg = null, suggAt = 0, suggPending = null, searchController = null;
  var RECENT = "pimwell.jump.recent." + location.host + "." + ($(".bar .me") || {}).textContent;
  function recent() { try { return JSON.parse(localStorage.getItem(RECENT) || "[]"); } catch (e) { return []; } }
  function remember(it) {
    try {
      var r = recent().filter(function (x) { return x.href !== it.href; });
      r.unshift({ label: it.label, hint: it.hint || "", href: it.href, group: "Recent" });
      localStorage.setItem(RECENT, JSON.stringify(r.slice(0, 6)));
    } catch (e) {}
  }
  function closeJump() { if (list) { list.remove(); list = null; } picks = []; at = -1; }
  function choose(it) { remember(it); closeJump(); jump.value = ""; jump.blur(); go(it.href); }
  function render(items) {
    closeJump(); if (!items.length) return;
    list = document.createElement("ul"); list.setAttribute("role", "listbox");
    var group = null;
    items.forEach(function (it) {
      if (it.group && it.group !== group) { group = it.group; var h = document.createElement("li"); h.className = "group"; h.setAttribute("role", "presentation"); h.textContent = group; list.appendChild(h); }
      var li = document.createElement("li"), a = document.createElement("a"), s = document.createElement("small");
      li.setAttribute("role", "option"); a.href = it.href; a.textContent = it.label; s.textContent = it.hint || ""; a.appendChild(s); li.appendChild(a); list.appendChild(li); picks.push({ li: li, it: it });
      li.addEventListener("mousedown", function (ev) { ev.preventDefault(); choose(it); });
    });
    jump.parentNode.appendChild(list);
  }
  function pick(d) { if (!picks.length) return; at = (at + d + picks.length) % picks.length; picks.forEach(function (p, i) { p.li.setAttribute("aria-selected", i === at ? "true" : "false"); if (i === at) p.li.scrollIntoView({ block: "nearest" }); }); }
  function base() { var seen = {}; return recent().concat(sugg || []).filter(function (x) { if (seen[x.href]) return false; seen[x.href] = 1; return true; }); }
  function matches(q) {
    var words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return base().filter(function (x) { var t = (x.label + " " + (x.hint || "")).toLowerCase(); return words.every(function (w) { return t.indexOf(w) >= 0; }); });
  }
  function loadSuggestions() {
    if (sugg && Date.now() - suggAt < 60000) return Promise.resolve();
    if (suggPending) return suggPending;
    suggPending = request("/jump?suggest=1", { headers: { accept: "application/json" }, credentials: "same-origin" }, function (r) { return r.json(); }).then(function (j) { sugg = j.results || []; suggAt = Date.now(); }).catch(function () {}).finally(function () { suggPending = null; });
    return suggPending;
  }
  function openEmpty() { render(base()); loadSuggestions().then(function () { if (document.activeElement === jump && !jump.value.trim()) render(base()); }); }
  if (jump) {
    jump.addEventListener("focus", function () { if (!jump.value.trim()) openEmpty(); });
    jump.addEventListener("input", function () {
      clearTimeout(timer); if (searchController) { searchController.abort(); searchController = null; }
      var q = jump.value.trim();
      if (!q) { openEmpty(); return; }
      var local = matches(q).map(function (x) { return { label: x.label, hint: x.hint, href: x.href }; });
      local.unshift({ label: "Search all projects for “" + q + "”", hint: "Enter to search · arrows to jump", href: "/search?q=" + encodeURIComponent(q), group: "Search" });
      render(local);
      timer = setTimeout(function () {
        searchController = new AbortController();
        var controller = searchController;
        Promise.all(["/search?format=json&q=", "/jump?q="].map(function (url) {
          return request(url + encodeURIComponent(q), { controller: controller, headers: { accept: "application/json" }, credentials: "same-origin" }, function (r) { return r.json(); });
        })).then(function (responses) {
          if (jump.value.trim() !== q || document.activeElement !== jump) return;
          var seen = {};
          render(local.concat(responses[0].results || [], responses[1].results || []).filter(function (x) {
            if (seen[x.href]) return false; seen[x.href] = 1; return true;
          }).slice(0, 14));
        }).catch(function () {});
      }, 250);
    });
    jump.addEventListener("keydown", function (e) {
      if (e.key === "ArrowDown") { e.preventDefault(); if (!list) openEmpty(); else pick(1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); pick(-1); }
      else if (e.key === "Escape") { closeJump(); jump.blur(); }
      else if (e.key === "Enter") {
        e.preventDefault();
        if (at >= 0 && picks[at]) choose(picks[at].it);
        else { var q = jump.value.trim(); if (q) choose({ label: q, href: "/search?q=" + encodeURIComponent(q) }); }
      }
    });
    jump.addEventListener("blur", function () { clearTimeout(timer); if (searchController) { searchController.abort(); searchController = null; } setTimeout(closeJump, 150); });
  }

  // Voice: a mic beside every message box marked data-voice. Hold it to talk and let go to stop, or tap once to
  // start and tap again to stop. The words land in the box, editable; a quiet second pass then fixes misheard names,
  // unless the person has already changed the text. Esc cancels a recording.
  function voiceContext(ta) {
    var pane = ta.closest(".pane") || document.body;
    var text = (pane.innerText || "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    if (text.length > 2400) text = text.slice(0, 800) + "\n...\n" + text.slice(-1600);
    var draft = ta.value.trim();
    return draft ? text + "\n\nDraft so far: " + draft.slice(-400) : text;
  }
  function voiceUp(root) {
    if (!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder)) return;
    $$("textarea[data-voice]", root).forEach(function (ta) {
      if (ta.getAttribute("data-voice-ready")) return; ta.setAttribute("data-voice-ready", "1");
      var b = document.createElement("button"); b.type = "button"; b.className = "mic";
      b.setAttribute("aria-label", "Talk. Hold, or tap to start and tap again to stop"); b.title = "Hold to talk, or tap to start and tap again to stop";
      b.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.93V21h2v-2.07A7 7 0 0 0 19 12h-2z"/></svg>';
      var st = document.createElement("span"); st.className = "voicestate"; st.setAttribute("aria-live", "polite");
      var box = ta.closest(".box");
      if (box) { box.insertBefore(b, box.querySelector(".send")); box.parentNode.insertBefore(st, box.nextSibling); }
      else { var bar = document.createElement("div"); bar.className = "voice-field"; ta.parentNode.insertBefore(bar, ta); bar.appendChild(ta); bar.appendChild(b); bar.appendChild(st); }
      wireMic(b, ta, st);
    });
  }
  function wireMic(b, ta, st) {
    var s = null;
    function say(t, cls) { st.textContent = t; st.className = "voicestate" + (cls ? " " + cls : ""); }
    function post(url, body, headers) {
      headers = headers || {}; headers["x-pimwell-voice"] = "1";
      var perfOp = window.pimwellTiming.start(url === "/voice/transcribe" ? "voice.transcribe" : "voice.correct"); perfOp.spinner = true;
      return request(url, { perfOp: perfOp, method: "POST", credentials: "same-origin", headers: headers, body: body }, function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }, function () { return { ok: false, j: {} }; }); });
    }
    function meter(me) {
      if (window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      try {
        var AC = window.AudioContext || window.webkitAudioContext; me.ac = new AC();
        var an = me.ac.createAnalyser(); an.fftSize = 512; me.ac.createMediaStreamSource(me.stream).connect(an);
        var buf = new Uint8Array(an.fftSize);
        (function loop() {
          an.getByteTimeDomainData(buf); var m = 0;
          for (var i = 0; i < buf.length; i++) { var d = Math.abs(buf[i] - 128); if (d > m) m = d; }
          b.style.setProperty("--lvl", Math.min(1, m / 50).toFixed(2)); me.raf = requestAnimationFrame(loop);
        })();
      } catch (e) {}
    }
    function clock(me) {
      var sec = Math.floor((Date.now() - me.started) / 1000);
      say("Listening " + Math.floor(sec / 60) + ":" + ("0" + (sec % 60)).slice(-2) + (me.hold ? " · let go to finish" : " · tap to finish"), "live");
      if (sec >= 600) stop();
    }
    function start() {
      var me = { chunks: [], started: Date.now(), downAt: Date.now() }; s = me;
      b.classList.add("live"); say("Listening…", "live");
      navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }).then(function (stream) {
        if (s !== me) { stream.getTracks().forEach(function (t) { t.stop(); }); return; }
        me.stream = stream;
        var types = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
        var type = types.filter(function (t) { return MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t); })[0];
        me.rec = type ? new MediaRecorder(stream, { mimeType: type }) : new MediaRecorder(stream);
        me.rec.ondataavailable = function (e) { if (e.data && e.data.size) me.chunks.push(e.data); };
        me.rec.onstop = function () { finish(me); };
        me.rec.start(250); me.started = Date.now();
        meter(me); me.tick = setInterval(function () { clock(me); }, 250);
        try { if (navigator.vibrate) navigator.vibrate(12); } catch (e) {}
        if (me.stopWanted) stop();
      }).catch(function () {
        if (s === me) s = null; b.classList.remove("live");
        say("The microphone isn't available. Allow it for this site in your browser's settings, then try again.", "err");
      });
    }
    function stop() { var me = s; if (!me) return; if (!me.rec) { me.stopWanted = true; return; } if (me.rec.state !== "inactive") me.rec.stop(); }
    function finish(me) {
      clearInterval(me.tick); if (me.raf) cancelAnimationFrame(me.raf); if (me.ac) try { me.ac.close(); } catch (e) {}
      me.stream.getTracks().forEach(function (t) { t.stop(); });
      if (s === me) s = null; b.classList.remove("live"); b.style.removeProperty("--lvl");
      var blob = new Blob(me.chunks, { type: (me.rec.mimeType || "audio/webm").split(";")[0] });
      if (me.cancelled) { say("", ""); return; }
      if (Date.now() - me.started < 500 || blob.size < 800) { say("That was too short. Hold the mic while you talk, or tap it, talk, and tap again.", ""); return; }
      say("Writing it down…", "busy"); b.disabled = true;
      var ctx = voiceContext(ta), fd = new FormData();
      fd.append("audio", blob, "speech"); fd.append("context", ctx);
      post("/voice/transcribe", fd).then(function (x) {
        if (!x.ok) { say("Not done: " + (x.j.reason || x.j.error || "try again"), "err"); return; }
        var text = (x.j.text || "").trim();
        if (!text) { say("I didn't catch any words. Try again a little closer to the mic.", ""); return; }
        var before = ta.value, sep = before && !/\s$/.test(before) ? " " : "";
        ta.value = before + sep + text; var mine = ta.value, at = before.length + sep.length;
        ta.dispatchEvent(new Event("input", { bubbles: true })); ta.focus();
        try { ta.setSelectionRange(ta.value.length, ta.value.length); } catch (e) {}
        say("Checking names…", "busy");
        post("/voice/correct", JSON.stringify({ text: text, context: ctx }), { "content-type": "application/json" }).then(function (y) {
          var settled = ta.value === mine;
          if (y.ok && y.j.changed && settled) {
            ta.value = ta.value.slice(0, at) + y.j.text; ta.dispatchEvent(new Event("input", { bubbles: true }));
            say("Fixed a few words", "ok"); setTimeout(function () { if (st.textContent === "Fixed a few words") say("", ""); }, 2500);
          } else say("", "");
          if (settled && ta.hasAttribute("data-voice-autosend") && ta.form) ta.form.requestSubmit();
        }, function () { say("", ""); if (ta.value === mine && ta.hasAttribute("data-voice-autosend") && ta.form) ta.form.requestSubmit(); });
      }, function () { say("Not done: the connection dropped. Try again.", "err"); }).then(function () { b.disabled = false; });
    }
    b.addEventListener("pointerdown", function (e) {
      if (e.button !== 0 || b.disabled) return; e.preventDefault();
      if (s) { stop(); return; }
      start(); s.holding = true;
      try { b.setPointerCapture(e.pointerId); } catch (x) {}
    });
    function up() { if (!s || !s.holding) return; s.holding = false; if (Date.now() - s.downAt > 350) { s.hold = true; stop(); } }
    b.addEventListener("pointerup", up); b.addEventListener("pointercancel", up);
    b.addEventListener("contextmenu", function (e) { e.preventDefault(); });
    b.addEventListener("click", function (e) { e.preventDefault(); if (e.detail === 0) { if (s) stop(); else start(); } });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape" && s) { s.cancelled = true; stop(); } });
  }
  function localTimes(root) {
    $$("time[data-local-time]", root).forEach(function (el) {
      var d = new Date(Number(el.getAttribute("data-local-time"))), now = new Date();
      el.textContent = timeText(d.getTime(), now.getTime());
      el.title = d.toLocaleString(undefined, {dateStyle:"full", timeStyle:"long"});
    });
  }
  localTimes(document);
  voiceUp(document);

  // Keyboard.
  function rows() { return $$("#list [data-href]").filter(function (r) { return r.offsetParent !== null; }); }
  function move(d) {
    var rs = rows(); if (!rs.length) return;
    var i = rs.findIndex(function (r) { return r.getAttribute("aria-selected") === "true"; });
    i = Math.min(rs.length - 1, Math.max(0, i + d));
    rs.forEach(function (r, k) { r.setAttribute("aria-selected", k === i ? "true" : "false"); });
    rs[i].scrollIntoView({ block: "nearest" });
    go(rs[i].getAttribute("data-href"));
  }
  document.addEventListener("keydown", function (e) {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { if (jump) { e.preventDefault(); jump.focus(); jump.select(); } return; }
    var t = e.target; if (t.closest && t.closest("input,textarea,select,[contenteditable]")) { if (e.key === "Escape") t.blur(); return; }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "j") move(1);
    else if (e.key === "k") move(-1);
    else if (e.key === "Enter" || e.key === "o") { var s = rows().find(function (r) { return r.getAttribute("aria-selected") === "true"; }); if (s) go(s.getAttribute("data-href")); }
    else if (e.key === "e") { var d = $("#inspector details.wb-inline-edit, #inspector details.edit"); if (d) { e.preventDefault(); d.open = true; var f = $("input:not([type=hidden]),textarea,select", d); if (f) f.focus(); } }
    else if (e.key === "c") { var b = $(".bar .file"); if (b) { e.preventDefault(); go(b.href); } }
    else if (e.key === "/") { var q = $("#list input[data-filter]") || jump; if (q) { e.preventDefault(); q.focus(); } }
    else if (e.key === "Escape") { closeRail(); closeInspector(); }
  });

  function grow(t) { t.style.height = "auto"; t.style.height = t.scrollHeight + 2 + "px"; }
  document.addEventListener("input", function (e) { var t = e.target; if (t.matches && t.matches("textarea[data-grow]")) grow(t); });

  document.addEventListener("keydown", function (e) {
    var t = e.target;
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing && t.matches && t.matches("textarea[data-enter-submits]") && t.form) { e.preventDefault(); if (t.value.trim()) t.form.requestSubmit(); }
  });

  // Copy buttons (data-copy="#id"): also on panes swapped in.
  if (!window.__pwCopy) {
    window.__pwCopy = 1;
    document.addEventListener("click", function (e) {
      var b = e.target.closest && e.target.closest("[data-copy]"); if (!b) return;
      var t = b.getAttribute("data-copy") === "address" ? b.parentElement.querySelector("code") : document.querySelector(b.getAttribute("data-copy")); if (!t) return;
      var v = t.tagName === "INPUT" || t.tagName === "TEXTAREA" ? t.value : t.textContent;
      var done = function () { var o = b.textContent; b.textContent = "Copied"; setTimeout(function () { b.textContent = o; }, 1600); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(v).then(done, function () {});
    });
  }

  // Quick filter over the visible list.
  document.addEventListener("input", function (e) {
    var f = e.target; if (!f.matches || !f.matches("input[data-filter]")) return;
    var q = f.value.trim().toLowerCase(), url = new URL(location.href);
    if (q) url.searchParams.set("filter", q); else url.searchParams.delete("filter");
    history.replaceState(history.state, "", url);
    applyFilter();
  });
  function applyFilter() {
    var q = new URL(location.href).searchParams.get("filter") || "", input = $("#list input[data-filter]");
    if (input) input.value = q;
    var explorer = $("#explorer"), project = explorer && explorer.getAttribute("data-project");
    if (project && location.pathname.indexOf("/" + project + "/") === 0) {
      $$("a", explorer).forEach(function (a) {
        var url = new URL(a.href);
        if (url.origin !== location.origin || url.pathname.indexOf("/" + project + "/") !== 0 || url.pathname.indexOf("/mcp") >= 0) return;
        if (q) url.searchParams.set("filter", q); else url.searchParams.delete("filter");
        a.href = url.href;
      });
    }
    $$("#list [data-href]").forEach(function (r) {
      r.style.display = !q || r.textContent.toLowerCase().indexOf(q.toLowerCase()) >= 0 ? "" : "none";
      var old = new URL(r.getAttribute("data-href"), location.href), url = new URL(old);
      if (q) url.searchParams.set("filter", q); else url.searchParams.delete("filter");
      r.setAttribute("data-href", url.pathname + url.search + url.hash);
      $$("a", r).forEach(function (a) { if (a.href === old.href) a.href = url.href; });
    });
  }
  applyFilter(); markSelected(); restoreList();
})();
`;
