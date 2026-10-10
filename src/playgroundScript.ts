export const PLAYGROUND_JS = String.raw`
for (const f of document.querySelectorAll("form.pg")) {
  if (f.dataset.ready) continue;
  f.dataset.ready = "1";
  f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const out = f.parentElement.querySelector(".out"); out.hidden = false; out.textContent = "Running...";
    let args; try { args = JSON.parse(f.args.value || "{}"); } catch { out.textContent = "Arguments are not valid JSON."; return; }
    const r = await fetch("/playground/call", { method: "POST", headers: { "content-type": "application/json", "x-pimwell-playground": "1" },
      body: JSON.stringify({ tool: f.dataset.tool, arguments: args, scopes: f.dataset.scopes }) });
    const j = await r.json().catch(() => ({ error: "unreadable response" }));
    out.replaceChildren();
    const add = (h, t) => { const d = document.createElement("div"); const b = document.createElement("h3"); b.textContent = h; const p = document.createElement("pre"); p.textContent = t; d.append(b, p); out.append(d); };
    if (!r.ok) { add("Refused (" + r.status + ")", JSON.stringify(j, null, 2)); return; }
    add("What the assistant reads (" + j.ms + " ms)", (j.response.result.content || []).map((c) => c.text).join("\n"));
    add("Request", JSON.stringify(j.request, null, 2)); add("Response", JSON.stringify(j.response, null, 2));
  });
}
`;