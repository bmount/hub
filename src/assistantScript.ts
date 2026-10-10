export const ASSISTANT_JS = String.raw`
(function () {
  var f = document.getElementById("ask"), log = document.getElementById("chatlog"); if (!f || f.dataset.ready) return; f.dataset.ready = "1";
  var pending = false;
  var coarse = window.matchMedia && matchMedia("(pointer:coarse)").matches;
  var esc = function (s) { return s.replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };
  function fmt(text) {
    var out = [], list = false;
    esc(text).split("\n").forEach(function (raw) {
      var b = /^\s*[-*] (.*)$/.exec(raw);
      if (b && !list) { out.push("<ul>"); list = true; } if (!b && list) { out.push("</ul>"); list = false; }
      var l = (b ? b[1] : raw).replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>").replace(/\x60([^\x60]+)\x60/g, "<code>$1</code>").replace(/\b([a-z][a-z0-9-]{1,62})#(\d{1,8})\b/g, '<a href="/$1/w/$2">$1#$2</a>');
      out.push(b ? "<li>" + l + "</li>" : l === "" ? "<br>" : "<p>" + l + "</p>");
    });
    if (list) out.push("</ul>"); return out.join("");
  }
  function steps(s) {
    if (!s || !s.length) return "";
    return '<details class="steps"><summary>Used ' + s.length + " tool" + (s.length === 1 ? "" : "s") + "</summary><ul>" + s.map(function (x) {
      return "<li><code>" + esc(x.tool) + "</code> <small>" + esc(x.arguments) + "</small>" + (x.ok ? "" : ' <span class="pill">refused</span>') + '<div class="lede">' + esc(x.summary) + "</div></li>"; }).join("") + "</ul></details>";
  }
  function add(role, html) {
    var e = log.querySelector(".welcome"); if (e) e.remove();
    var d = document.createElement("div"); d.className = "msg " + role;
    d.innerHTML = (role === "assistant" ? '<div class="who" aria-hidden="true">P</div>' : "") + '<div class="body">' + html + "</div>";
    log.appendChild(d); d.scrollIntoView({ block: "end", behavior: "smooth" }); return d.querySelector(".body");
  }
  function grow() { f.text.style.height = "auto"; f.text.style.height = Math.min(f.text.scrollHeight, innerHeight * 0.4) + "px"; }
  f.text.addEventListener("input", grow);
  f.text.addEventListener("keydown", function (e) { if (e.key === "Enter" && !e.shiftKey && !coarse) { e.preventDefault(); f.requestSubmit(); } });
  log.addEventListener("click", function (e) {
    var s = e.target.closest("[data-ask]"); if (s) { f.text.value = s.getAttribute("data-ask"); f.requestSubmit(); return; }
    var r = e.target.closest("[data-retry]"); if (r && !pending) { var t = r.getAttribute("data-retry"); r.closest(".msg").remove(); send(t, false); }
  });
  function bindThread(id, title) {
    if (!f.isConnected || f.thread.value || !id) return;
    f.thread.value = id;
    var url = "/assistant?t=" + encodeURIComponent(id);
    // Match the server's pane key so opening Conversations keeps this live transcript.
    f.closest(".pane").setAttribute("data-key", "assistant:" + id);
    f.closest(".assist").querySelector("[data-chat-link]").href = url;
    f.closest(".assist").querySelector("[data-tools-link]").href = "/assistant/tools?t=" + encodeURIComponent(id);
    f.closest(".assist").querySelector("[data-conversations-link]").href = url + "&list=1";
    var back = document.querySelector("#inspector .back"); if (back) back.href = url;
    history.replaceState(history.state, "", url);
    document.title = title.replace(/\s+/g, " ").slice(0, 80);
  }
  function send(t, echo) {
    if (pending) return;
    pending = true;
    if (echo) add("user", esc(t));
    var w = add("assistant", '<div class="thinking"><i></i><i></i><i></i> Looking through ' + esc(f.dataset.org) + "…</div>");
    var btn = f.querySelector(".send"); btn.disabled = true;
    var fail = function (why) { w.innerHTML = '<p class="err">Not done: ' + esc(why) + '</p><button type="button" class="quiet" data-retry="' + esc(t) + '">Try again</button>'; };
    fetch("/assistant/chat", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", "x-pimwell-playground": "1" },
      body: JSON.stringify({ thread: f.thread.value || null, text: t, scopes: f.scopes.value }) })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (x) {
        bindThread(x.j.thread, t);
        if (!x.ok) { fail(x.j.reason || x.j.error || "something went wrong"); return; }
        w.innerHTML = fmt(x.j.reply) + steps(x.j.steps); w.scrollIntoView({ block: "end", behavior: "smooth" });
      })
      .catch(function () { fail("the connection dropped"); })
      .then(function () { pending = false; btn.disabled = false; if (!coarse) f.text.focus(); });
  }
  f.addEventListener("submit", function (e) {
    e.preventDefault(); if (pending) return;
    var t = f.text.value.trim(); if (!t) return;
    f.text.value = ""; grow(); send(t, true);
  });
  var last = log.lastElementChild; if (last && !log.querySelector(".welcome")) last.scrollIntoView({ block: "end" });
  var auto = f.text.getAttribute("data-autoask"); if (auto) { f.text.removeAttribute("data-autoask"); f.text.value = auto; f.requestSubmit(); }
})();
`;
