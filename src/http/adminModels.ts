// "Models and keys" (admin spec 10.4): what is needed, what is in use, and how to change it. Apex, root only.
import type { Env } from "../env";
import { shellFor } from "./shell";
import { esc, htmlResponse, page } from "../html";
import { buildContext } from "../auth/context";
import { clearSessionCookie } from "../auth/cookie";
import { notFoundPage } from "./pages";
import { listCredentials, purposeStatus, revealSecret } from "../models/store";
import { PROVIDERS, provider as providerById } from "../models/providers";
import { newerModels } from "../models/purposes";

const when = (ms: number | null) => (ms ? new Date(ms).toISOString().slice(0, 16).replace("T", " ") : "never");
const BACK = `<input type="hidden" name="_back" value="/admin/models">`;
const form = (verb: string, fields: Record<string, string>, label: string) =>
  `<form class="inline" method="post" action="/api/${verb}">${Object.entries(fields).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join("")}${BACK}<button type="submit">${esc(label)}</button></form>`;

export async function adminModelsPage(request: Request, env: Env): Promise<Response> {
  const ctx = await buildContext(request, env);
  const extra: Record<string, string> = ctx.staleCookie ? { "set-cookie": clearSessionCookie(env.HUB_DOMAIN) } : {};
  if (ctx.host.kind !== "apex" || !ctx.identity || ctx.identity.kind !== "human" || ctx.identity.is_root !== 1) return notFoundPage(extra);

  const [purposes, keys, prices] = await Promise.all([purposeStatus(ctx.db, null, ctx.now), listCredentials(ctx.db, null),
    ctx.db.prepare(`SELECT p.provider, p.model, p.input_per_mtok, p.output_per_mtok, p.cached_input_per_mtok, p.effective_from FROM model_price p
      WHERE p.effective_from = (SELECT MAX(q.effective_from) FROM model_price q WHERE q.provider = p.provider AND q.model = p.model) ORDER BY p.provider, p.model`)
      .all<{ provider: string; model: string; input_per_mtok: number; output_per_mtok: number; cached_input_per_mtok: number | null; effective_from: number }>().then((r) => r.results)]);
  const unpriced = (await ctx.db.prepare(`SELECT m.provider, m.model, COUNT(*) AS n FROM model_call m WHERE m.cost_micros IS NULL AND m.created_at > ? GROUP BY m.provider, m.model ORDER BY n DESC LIMIT 20`)
    .bind(ctx.now - 30 * 86_400_000).all<{ provider: string; model: string; n: number }>()).results;
  // The live model list, from the active key of each provider in use; failures just leave the list empty.
  const models = new Map<string, string[]>();
  for (const pid of new Set(purposes.map((p) => p.route.provider))) {
    const active = keys.find((k) => k.provider === pid && k.status === "active");
    const prov = providerById(pid);
    if (!active || !prov || !env.HUB_SECRETS_KEY) continue;
    try {
      const r = await prov.verify(await revealSecret(ctx.db, env.HUB_SECRETS_KEY, active.id));
      if (r.ok) models.set(pid, r.models);
    } catch { /* shown as no list */ }
  }

  const needed = purposes.filter((p) => p.needed);
  const neededHtml = !env.HUB_SECRETS_KEY
    ? `<p><strong>Setup needed:</strong> the Worker secret <code>HUB_SECRETS_KEY</code> is missing, so keys cannot be stored.</p>`
    : needed.length
      ? `<ul>${needed.map((p) => `<li><strong>${esc(p.title)}</strong>: ${esc(p.needed!)}</li>`).join("")}</ul>`
      : `<p>Every purpose has a working route.</p>`;

  const inUse = purposes.map((p) => {
    const list = models.get(p.route.provider) ?? [];
    const newer = newerModels(p.route.model, list);
    const options = [...newer, ...list.filter((m) => !newer.includes(m))].map((m) => `<option value="${esc(m)}">`).join("");
    return `<tr><td><strong>${esc(p.title)}</strong><br><small>${esc(p.why)}</small></td>
<td>${esc(providerById(p.route.provider)?.name ?? p.route.provider)}<br><code>${esc(p.route.model)}</code><br><small>${p.route.source === "default" ? "default" : "set by admin"}</small></td>
<td>${p.key ? `<code>${esc(p.key.fingerprint)}</code><br><small>${esc(p.key.label)}</small>` : "<em>none</em>"}</td>
<td>${p.calls_24h} calls, ${p.errors_24h} errors${newer.length ? `<br><small><strong>Newer available:</strong> ${newer.slice(0, 4).map((m) => `<code>${esc(m)}</code>`).join(", ")}</small>` : ""}</td>
<td><form method="post" action="/api/model.route_set"><input type="hidden" name="purpose" value="${esc(p.purpose)}"><input type="hidden" name="provider" value="${esc(p.route.provider)}">
<input name="model" value="${esc(p.route.model)}" list="models-${esc(p.purpose)}" size="18" required><datalist id="models-${esc(p.purpose)}">${options}</datalist>${BACK}<button type="submit">Change</button></form>
${form("model.test", { purpose: p.purpose }, "Test")}</td></tr>`;
  }).join("");

  const keyRows = keys.map((k) => `<tr><td>${esc(providerById(k.provider)?.name ?? k.provider)}</td><td><code>${esc(k.fingerprint)}</code><br><small>${esc(k.label)}</small></td>
<td><strong>${esc(k.status)}</strong></td><td>${when(k.verified_at)}${k.verify_error ? `<br><small>failed: ${esc(k.verify_error)}</small>` : ""}</td>
<td>${when(k.last_used_at)}${k.last_error ? `<br><small>last error ${when(k.last_error_at)}: ${esc(k.last_error)}</small>` : ""}</td>
<td>${k.status === "retired" ? `retired ${when(k.retired_at)}` : [
    form("provider.key_verify", { key_id: k.id }, "Check now"),
    k.status === "standby" ? form("provider.key_promote", { key_id: k.id }, "Make active") : "",
    k.status === "standby" ? form("provider.key_retire", { key_id: k.id }, "Retire") : "",
  ].join(" ")}</td></tr>`).join("");

  const providerOptions = Object.values(PROVIDERS).map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join("");
  const hints = Object.values(PROVIDERS).map((p) => `<li>${esc(p.name)}: ${esc(p.keyHint)}</li>`).join("");

  const body = `<h1>Models and keys</h1><p><a href="/">back</a></p>
<h2>Needed</h2>${neededHtml}
<h2>In use</h2>
<table><thead><tr><th>Purpose</th><th>Model</th><th>Key</th><th>Last 24 hours</th><th>Change</th></tr></thead><tbody>${inUse}</tbody></table>
<h2>Keys</h2>
${keys.length ? `<table><thead><tr><th>Provider</th><th>Key</th><th>Status</th><th>Checked</th><th>Used</th><th></th></tr></thead><tbody>${keyRows}</tbody></table>` : "<p>No keys yet.</p>"}
<h3>Add or rotate a key</h3>
<p>A new key is checked with the provider before it is saved. If the provider already has an active key, the new one waits as standby. Make it active when you are ready; the old key then becomes standby, so switching back is one click. Retire the old key once the new one has worked for a day, and revoke it at the provider.</p>
<form method="post" action="/api/provider.key_add">
<label>Provider <select name="provider">${providerOptions}</select></label>
<label>Label <input name="label" maxlength="80" placeholder="for example: hub key, October"></label>
<label>Key <input name="key" type="password" autocomplete="off" required maxlength="400"></label>${BACK}
<button type="submit">Check and save</button></form>
<ul>${hints}</ul>
<p><small>Keys are encrypted at rest with the hub's own secret. They are never shown again, never sent to an assistant, and never written to logs.</small></p>
<h2>Prices</h2>
<p class="lede">Dollars per million tokens. Each recorded AI call keeps the cost it had when it happened; a new price applies from now on. Calls with no price show as "price unknown", never a guess.</p>
${prices.length ? `<table><thead><tr><th>Model</th><th>Input</th><th>Cached input</th><th>Output</th><th>Since</th></tr></thead><tbody>${prices.map((p) => `<tr><td><code>${esc(p.provider)}/${esc(p.model)}</code></td><td>$${p.input_per_mtok / 1e6}</td><td>${p.cached_input_per_mtok === null ? "same as input" : `$${p.cached_input_per_mtok / 1e6}`}</td><td>$${p.output_per_mtok / 1e6}</td><td>${new Date(p.effective_from).toISOString().slice(0, 10)}</td></tr>`).join("")}</tbody></table>` : "<p>No prices yet.</p>"}
${unpriced.length ? `<p>Used without a price in the last 30 days: ${unpriced.map((u) => `<code>${esc(u.provider)}/${esc(u.model)}</code> (${u.n})`).join(", ")}</p>` : ""}
<form method="post" action="/api/model.price_set">
<label>Provider <input name="provider" required maxlength="40" size="10" placeholder="openai"></label>
<label>Model <input name="model" required maxlength="80" size="18"></label>
<label>Input $ <input name="input_usd" required inputmode="decimal" size="6"></label>
<label>Cached input $ <input name="cached_input_usd" inputmode="decimal" size="6"></label>
<label>Output $ <input name="output_usd" required inputmode="decimal" size="6"></label>${BACK}
<button type="submit">Set price</button></form>`;
  return htmlResponse(page("Models and keys", body, shellFor(ctx, env, "admin", "models")), 200, extra);
}
