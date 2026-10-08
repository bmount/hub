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
      if (a && b && (a.getAttribute("data-key") !== b.getAttribute("data-key") || id === "inspector")) { a.replaceWith(b); revive(b); voiceUp(b); }
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
    }).catch(function () { if (opts.fallback) opts.fallback(); else location.href = url; }).then(function () { if (mine === busy) document.body.style.cursor = ""; });
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
    // If the fetch fails (for example the server sends a sign-in confirmation on another host), submit the form the
    // ordinary way so the browser follows it; never turn a post into a GET of the form's address.
    var sub = e.submitter;
    var native = function () { f.setAttribute("data-reload", ""); if (f.requestSubmit) f.requestSubmit(sub || undefined); else f.submit(); };
    if ((f.getAttribute("method") || "get").toLowerCase() === "post") go(u.href, { method: "POST", body: data, fallback: native });
    else { u.search = data.toString(); go(u.href); }
  });
  window.addEventListener("popstate", function () { go(location.href, { push: false }); });

  // Jump palette. Focus opens likely places at once (recent picks from this browser, then the record's suggestions:
  // sections, your open work, active projects), so most jumps are one tap. Typing narrows them instantly, word by
  // word, and the full search fills in behind.
  var jump = $(".jump input"), list = null, picks = [], at = -1, timer = 0, sugg = null, suggAt = 0;
  var RECENT = "pimwell.jump.recent." + location.host;
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
    return fetch("/jump?suggest=1", { headers: { accept: "application/json" }, credentials: "same-origin" })
      .then(function (r) { return r.json(); }).then(function (j) { sugg = j.results || []; suggAt = Date.now(); }).catch(function () {});
  }
  function openEmpty() { render(base()); loadSuggestions().then(function () { if (document.activeElement === jump && !jump.value.trim()) render(base()); }); }
  if (jump) {
    jump.addEventListener("focus", function () { if (!jump.value.trim()) openEmpty(); });
    jump.addEventListener("input", function () {
      clearTimeout(timer); var q = jump.value.trim();
      if (!q) { openEmpty(); return; }
      var local = matches(q).map(function (x) { return { label: x.label, hint: x.hint, href: x.href }; });
      if (q.split(/\s+/).length >= 3) local.unshift({ label: "Do it: " + q, hint: "Pimwell finds the way", href: "/do?q=" + encodeURIComponent(q) });
      render(local);
      timer = setTimeout(function () {
        fetch("/jump?q=" + encodeURIComponent(q), { headers: { accept: "application/json" }, credentials: "same-origin" })
          .then(function (r) { return r.json(); }).then(function (j) {
            if (jump.value.trim() !== q) return;
            var seen = {}; local.forEach(function (x) { seen[x.href] = 1; });
            render(local.concat((j.results || []).filter(function (x) { return !seen[x.href]; })).slice(0, 14));
          }).catch(function () {});
      }, 90);
    });
    jump.addEventListener("keydown", function (e) {
      if (e.key === "ArrowDown") { e.preventDefault(); if (!list) openEmpty(); else pick(1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); pick(-1); }
      else if (e.key === "Escape") { closeJump(); jump.blur(); }
      else if (e.key === "Enter" && picks.length) { e.preventDefault(); choose(picks[Math.max(at, 0)].it); }
    });
    jump.addEventListener("blur", function () { setTimeout(closeJump, 150); });
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
      else { var bar = document.createElement("div"); bar.className = "voicebar"; bar.appendChild(b); bar.appendChild(st); ta.parentNode.insertBefore(bar, ta.nextSibling); }
      wireMic(b, ta, st);
    });
  }
  function wireMic(b, ta, st) {
    var s = null;
    function say(t, cls) { st.textContent = t; st.className = "voicestate" + (cls ? " " + cls : ""); }
    function post(url, body, headers) {
      headers = headers || {}; headers["x-pimwell-voice"] = "1";
      return fetch(url, { method: "POST", credentials: "same-origin", headers: headers, body: body })
        .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }, function () { return { ok: false, j: {} }; }); });
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
  voiceUp(document);

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

  function grow(t) { t.style.height = "auto"; t.style.height = t.scrollHeight + 2 + "px"; }
  document.addEventListener("input", function (e) { var t = e.target; if (t.matches && t.matches("textarea[data-grow]")) grow(t); });

  document.addEventListener("keydown", function (e) {
    var t = e.target;
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing && t.matches && t.matches("textarea[data-enter-submits]") && t.form) { e.preventDefault(); if (t.value.trim()) t.form.requestSubmit(); }
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
