// The workbench's only script: progressive enhancement over pages that already work without it.
// - Links and forms inside the workbench fetch the next page and swap only the panes that changed (a pane keeps its
//   place when its data-key is the same), so the list keeps its scroll while the inspector changes.
// - Keyboard: ⌘K or Ctrl+K jump, j and k move through the list, Enter opens, e edits, c files, / filters, Esc closes.
// - The status bar shows the server's own timing for the last page (Server-Timing).
// Written without template literals so it can live in a TypeScript string.
export const WORKBENCH_JS = String.raw`
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
    var here = location.pathname;
    $$("#list [data-href]").forEach(function (r) { r.setAttribute("aria-selected", new URL(r.getAttribute("data-href"), location.href).pathname === here ? "true" : "false"); });
  }
  function closeRail() { var r = $("#rail"); if (r) r.classList.remove("open"); if (location.hash === "#rail") history.replaceState(history.state, "", location.pathname + location.search); }

  // Scripts that arrive in a swapped pane never run on their own (parsed HTML is inert); run each one now, once.
  function revive(root) {
    $$("script", root).forEach(function (old) {
      var s = document.createElement("script");
      for (var i = 0; i < old.attributes.length; i++) s.setAttribute(old.attributes[i].name, old.attributes[i].value);
      s.textContent = old.textContent;
      old.replaceWith(s);
    });
  }

  function swap(doc, url, push) {
    var cur = $("main.panes"), next = doc.querySelector("main.panes");
    if (!cur || !next) { location.href = url; return; }
    ["list", "inspector"].forEach(function (id) {
      var a = document.getElementById(id), b = doc.getElementById(id);
      if (a && b && (a.getAttribute("data-key") !== b.getAttribute("data-key") || id === "inspector")) { a.replaceWith(b); revive(b); }
    });
    cur.className = next.className;
    var rail = $("#rail"), nrail = doc.getElementById("rail");
    if (rail && nrail) { var top = rail.scrollTop; rail.innerHTML = nrail.innerHTML; rail.scrollTop = top; }
    var tabs = $(".tabs"), ntabs = doc.querySelector(".tabs"); if (tabs && ntabs) tabs.innerHTML = ntabs.innerHTML;
    var tip = $(".status .tip"), ntip = doc.querySelector(".status .tip"); if (tip && ntip) tip.textContent = ntip.textContent;
    document.body.setAttribute("data-focus", doc.body.getAttribute("data-focus") || "list");
    document.title = doc.title;
    if (push) history.pushState({ wb: 1 }, "", url); else history.replaceState({ wb: 1 }, "", url);
    closeRail(); markSelected();
    var ins = $("#inspector"); if (ins && document.body.getAttribute("data-focus") === "inspector") ins.scrollTop = 0;
  }

  var busy = 0;
  function go(url, opts) {
    opts = opts || {};
    var init = { method: opts.method || "GET", credentials: "same-origin", headers: { "x-workbench": "1" } };
    if (opts.body) { init.body = opts.body; init.headers["content-type"] = "application/x-www-form-urlencoded"; }
    var mine = ++busy; document.body.style.cursor = "progress";
    return fetch(url, init).then(function (res) {
      timing(res.headers.get("server-timing"));
      return res.text().then(function (html) {
        if (mine !== busy) return;
        var doc = new DOMParser().parseFromString(html, "text/html");
        if (!doc.body || !doc.body.classList.contains("wb")) {
          if (init.method === "GET") { location.href = url; return; }
          var ins = $("#inspector"), main = doc.querySelector("main");
          $("main.panes").classList.remove("one");
          ins.innerHTML = main ? main.innerHTML : html; document.body.setAttribute("data-focus", "inspector"); return;
        }
        swap(doc, res.url || url, opts.push !== false);
      });
    }).catch(function () { location.href = url; }).then(function () { if (mine === busy) document.body.style.cursor = ""; });
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
    if (a && a.getAttribute("href") === "#rail") { e.preventDefault(); var r = $("#rail"); if (r) r.classList.toggle("open"); return; }
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
    var t = e.touches[0], r = $("#rail");
    var open = !!(r && (r.classList.contains("open") || location.hash === "#rail"));
    touch = { x: t.clientX, y: t.clientY, at: Date.now(), open: open, axis: null, dx: 0 };
  }, { passive: true });
  document.addEventListener("touchmove", function (e) {
    if (!touch) return;
    var t = e.touches[0], dx = t.clientX - touch.x, dy = t.clientY - touch.y;
    if (!touch.axis && (Math.abs(dx) > 10 || Math.abs(dy) > 10)) touch.axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
    touch.dx = dx;
    if (touch.open && touch.axis === "x") { var r = $("#rail"); r.style.transition = "none"; r.style.transform = "translateX(" + Math.min(0, dx) + "px)"; }
  }, { passive: true });
  document.addEventListener("touchend", function () {
    if (!touch) return;
    var t = touch; touch = null;
    var r = $("#rail");
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
    fetch(f.getAttribute("action"), { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(body) })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var note = document.createElement("p"); note.className = "lede";
        if (j.ok) {
          var ref = j.result && j.result.ref, m = ref && /^([a-z0-9-]+)#(\d+)$/.exec(ref);
          note.textContent = "Done. ";
          if (m) { var a = document.createElement("a"); a.href = "/" + m[1] + "/w/" + m[2]; a.textContent = "Filed " + ref; note.textContent = ""; note.appendChild(a); }
          f.replaceWith(note);
        } else { note.textContent = "Not done: " + (j.detail || j.error); f.appendChild(note); if (btn) btn.disabled = false; }
      }).catch(function () { if (btn) btn.disabled = false; f.submit(); });
  }
  document.addEventListener("submit", function (e) {
    var f = e.target; if (e.defaultPrevented || f.getAttribute("data-reload") !== null) return;
    if (f.hasAttribute("data-inline")) { e.preventDefault(); inline(f); return; }
    var u = new URL(f.getAttribute("action") || location.href, location.href);
    if (u.origin !== location.origin || /^\/(login|logout|oauth|auth|invite)\b/.test(u.pathname)) return;
    e.preventDefault();
    // Include the button that was pressed: forms like Approve / Ask for changes carry their choice on it.
    var data = new URLSearchParams(e.submitter ? new FormData(f, e.submitter) : new FormData(f));
    if ((f.getAttribute("method") || "get").toLowerCase() === "post") go(u.href, { method: "POST", body: data });
    else { u.search = data.toString(); go(u.href); }
  });
  window.addEventListener("popstate", function () { go(location.href, { push: false }); });

  // Jump palette.
  var jump = $(".jump input"), list = null, picks = [], at = -1, timer = 0;
  function closeJump() { if (list) { list.remove(); list = null; } picks = []; at = -1; }
  function render(items) {
    closeJump(); if (!items.length) return;
    list = document.createElement("ul"); list.setAttribute("role", "listbox");
    items.forEach(function (it, i) {
      var li = document.createElement("li"), a = document.createElement("a"), s = document.createElement("small");
      a.href = it.href; a.textContent = it.label; s.textContent = it.hint || ""; a.appendChild(s); li.appendChild(a); list.appendChild(li); picks.push(li);
      li.addEventListener("mousedown", function (ev) { ev.preventDefault(); closeJump(); jump.blur(); go(it.href); });
    });
    jump.parentNode.appendChild(list);
  }
  function pick(d) { if (!picks.length) return; at = (at + d + picks.length) % picks.length; picks.forEach(function (p, i) { p.setAttribute("aria-selected", i === at ? "true" : "false"); }); }
  if (jump) {
    jump.addEventListener("input", function () {
      clearTimeout(timer); var q = jump.value.trim(); if (!q) { closeJump(); return; }
      timer = setTimeout(function () {
        fetch("/jump?q=" + encodeURIComponent(q), { headers: { accept: "application/json" }, credentials: "same-origin" })
          .then(function (r) { return r.json(); }).then(function (j) { if (jump.value.trim() === q) render(j.results || []); }).catch(function () {});
      }, 90);
    });
    jump.addEventListener("keydown", function (e) {
      if (e.key === "ArrowDown") { e.preventDefault(); pick(1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); pick(-1); }
      else if (e.key === "Escape") { closeJump(); jump.blur(); }
      else if (e.key === "Enter" && picks.length) { e.preventDefault(); var a = $("a", picks[Math.max(at, 0)]); closeJump(); jump.value = ""; jump.blur(); go(a.href); }
    });
    jump.addEventListener("blur", function () { setTimeout(closeJump, 120); });
  }

  // Keyboard.
  function rows() { return $$("#list [data-href]").filter(function (r) { return r.offsetParent !== null; }); }
  function move(d) {
    var rs = rows(); if (!rs.length) return;
    var i = rs.findIndex(function (r) { return r.getAttribute("aria-selected") === "true"; });
    i = Math.min(rs.length - 1, Math.max(0, i + d));
    rs.forEach(function (r, k) { r.setAttribute("aria-selected", k === i ? "true" : "false"); });
    rs[i].scrollIntoView({ block: "nearest" });
  }
  document.addEventListener("keydown", function (e) {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { if (jump) { e.preventDefault(); jump.focus(); jump.select(); } return; }
    var t = e.target; if (t.closest && t.closest("input,textarea,select,[contenteditable]")) { if (e.key === "Escape") t.blur(); return; }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "j") move(1);
    else if (e.key === "k") move(-1);
    else if (e.key === "Enter" || e.key === "o") { var s = rows().find(function (r) { return r.getAttribute("aria-selected") === "true"; }); if (s) go(s.getAttribute("data-href")); }
    else if (e.key === "e") { var d = $("#inspector details.edit"); if (d) { e.preventDefault(); d.open = true; var f = $("input,textarea,select", d); if (f) f.focus(); } }
    else if (e.key === "c") { var b = $(".bar .file"); if (b) { e.preventDefault(); go(b.href); } }
    else if (e.key === "/") { var q = $("#list input[data-filter]") || jump; if (q) { e.preventDefault(); q.focus(); } }
    else if (e.key === "Escape") { closeRail(); var back = $("#inspector .back"); if (back && document.body.getAttribute("data-focus") === "inspector" && innerWidth <= 760) go(back.href); }
  });

  // Quick filter over the visible list.
  document.addEventListener("input", function (e) {
    var f = e.target; if (!f.matches || !f.matches("input[data-filter]")) return;
    var q = f.value.trim().toLowerCase();
    $$("#list [data-href]").forEach(function (r) { r.style.display = !q || r.textContent.toLowerCase().indexOf(q) >= 0 ? "" : "none"; });
  });
  markSelected();
})();
`;
