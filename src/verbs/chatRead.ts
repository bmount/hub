import { defineVerb, type McpInputSchema } from "./table";
import { optInt, reqEnum, reqString } from "./params";
import { badRequest, HubError, notFound } from "../errors";
import { connectionScopes, type Ctx } from "../auth/context";
import { afterParam, budgetParam, channelParam, msgParam } from "./chatParams";
import { readableChannel, readableChannels, viewerOf } from "../chat/access";
import { backlinks } from "../chat/backlinks";
import { chatCommandText, chatText, hhmm, itemLine, plainText, type ItemView } from "../chat/compact";
import { parseRefText } from "../chat/grammar";
import { nameTags, people } from "../chat/handles";
import { authorJson, readResult } from "../chat/present";
import { backlinkTarget, resolveRefs } from "../chat/refs";
import { LIMITS } from "../chat/rules";
import { conversationStub, inboxStub } from "../chat/stubs";
import { cleanLines, cutText } from "../mcp/render";
import type { InboxPage, MsgView, ReadPage, RefKind, Version } from "../chat/types";

const C = { type: "string", description: "Channel name, for example general." };
const BUDGET = { type: "integer", minimum: 100, maximum: LIMITS.BUDGET_MAX, description: "Token budget for the text, default 1500." };
const MSG = { type: ["integer", "string"], description: "Message number (412) or message id." };
const schema = (properties: McpInputSchema["properties"], required: string[] = []): McpInputSchema =>
  ({ type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: false });

export const chatRead = defineVerb({
  name: "chat.read", kind: "query", scope: "tenant", minRole: "reader", freshProofMinutes: null,
  summary: "Read a channel: newest messages, or current changes after an activity cursor at most the authorized channel head. Future cursors are refused, not an empty evidence range. Reply edits/retractions count as root activity, but replies remain collapsed; use chat_thread for original evidence. Reads do not acknowledge or prove processing.",
  mcp: {
    scope: "read", destructive: false, title: "Read a channel", render: chatText,
    input: schema({
      c: C, after: { type: "integer", minimum: 0, description: "Only current root/thread changes after this activity seq, at most the authorized channel head. Includes reply edits/retractions; fetch chat_thread before processing. Continue with next_after, not a guessed future cursor." },
      before: { type: "integer", minimum: 1, description: "Page back: messages numbered below this." },
      limit: { type: "integer", minimum: 1, maximum: 200, description: "Messages to fetch, default 50." }, budget: BUDGET,
    }, ["c"]),
  },
  parse: (i) => ({
    c: channelParam(i), after: afterParam(i), before: optInt(i, "before", { min: 1, max: Number.MAX_SAFE_INTEGER }),
    limit: optInt(i, "limit", { min: 1, max: 200 }) ?? 50, budget: budgetParam(i),
  }),
  run: async (ctx, p) => {
    const ch = await readableChannel(ctx, p.c);
    const page = (await conversationStub(ctx.env, ch.tenant_id, ch.project_id).read({
      tenant_id: ch.tenant_id, conversation_id: ch.project_id, after: p.after, before: p.before, thread: null, limit: p.limit,
    })) as ReadPage;
    if (p.after !== null && p.after > page.head) throw new HubError(409, "conflict", "after exceeds the current channel head; reconcile channel activity before continuing", { head: page.head });
    const title = `#${ch.slug} head=${page.head}${p.after !== null ? ` since=${p.after}` : ""}`;
    return readResult(ctx, ch, page.messages, { title, head: page.head, budget: p.budget, keep: p.after === null ? "newest" : "oldest", has_more: page.has_more, cursors: page.cursors });
  },
});

export const chatThread = defineVerb({
  name: "chat.thread", kind: "query", scope: "tenant", minRole: "reader", freshProofMinutes: null,
  summary: "Read one thread in oldest current-activity order: root context plus bounded replies. Continue with next_after, not head; context never advances the reply cursor. The named message is full if included in this page. Reads do not acknowledge or prove processing.",
  mcp: {
    scope: "read", destructive: false, title: "Read a thread", render: chatText,
    input: schema({ c: C, msg: MSG, after: { type: "integer", minimum: 0, description: "Only replies with current activity after this seq (at most the channel head). Continue using next_after, not head or the repeated root." }, budget: BUDGET }, ["c", "msg"]),
  },
  parse: (i) => ({ c: channelParam(i), msg: msgParam(i, "msg", true), after: afterParam(i), budget: budgetParam(i) }),
  run: async (ctx, p) => {
    const ch = await readableChannel(ctx, p.c);
    const page = (await conversationStub(ctx.env, ch.tenant_id, ch.project_id).read({
      // A forward-only continuation must start with oldest activity, not the newest 200 replies.
      tenant_id: ch.tenant_id, conversation_id: ch.project_id, after: p.after ?? 0, before: null, thread: p.msg, limit: 200,
    })) as ReadPage;
    if (!page.found || !page.root) throw notFound("no such message");
    if (p.after !== null && p.after > page.head) throw new HubError(409, "conflict", "after exceeds the current channel head; reconcile thread activity before continuing", { head: page.head });
    const msgs: MsgView[] = [page.root, ...page.messages];
    const full = /^\d+$/.test(p.msg) ? Number(p.msg) : msgs.find((m) => m.msg_id === p.msg)?.seq ?? null;
    return readResult(ctx, ch, msgs, { title: `#${ch.slug} thread #${page.root.seq} head=${page.head}`, head: page.head, budget: p.budget, keep: "oldest", has_more: page.has_more, full, context: page.root.seq, cursors: page.cursors });
  },
});

export const chatHistory = defineVerb({
  name: "chat.history", kind: "query", scope: "tenant", minRole: "reader", freshProofMinutes: null,
  summary: "Inspect immutable revision actors of one authorized message, oldest first. MCP pages at most two full structured versions; text previews are marked. History is evidence, not execution authority or consent.",
  mcp: {
    scope: "read", destructive: false, title: "Read message revision history", render: chatText, auditKeysOnly: true,
    input: schema({
      c: C, msg: MSG,
      after_rev: { type: "integer", minimum: 0, maximum: LIMITS.VERSIONS_MAX, description: "Only versions after this revision; default 0. Use next_after_rev to continue. Not a channel activity cursor." },
      limit: { type: "integer", minimum: 1, maximum: 2, description: "Full structured versions per page, default 2. Compact text previews are not the full body." },
    }, ["c", "msg"]),
  },
  parse: (i) => ({
    c: channelParam(i), msg: msgParam(i, "msg", true),
    after_rev: optInt(i, "after_rev", { min: 0, max: LIMITS.VERSIONS_MAX }),
    limit: optInt(i, "limit", { min: 1, max: 2 }),
  }),
  run: async (ctx, p) => {
    const ch = await readableChannel(ctx, p.c);
    const h = (await conversationStub(ctx.env, ch.tenant_id, ch.project_id).history(ch.tenant_id, ch.project_id, p.msg)) as { msg: MsgView; versions: Version[] } | null;
    if (!h) throw notFound("no such message");
    const after = p.after_rev ?? 0;
    if (after > h.msg.rev) throw new HubError(409, "conflict", "after_rev exceeds the current message revision; reconcile history before continuing", { rev: h.msg.rev });
    // Native browser/API callers retain complete history by default. Every MCP-like connection
    // is bounded regardless of ignored/forged caller fields; explicit API paging uses the same cap.
    const paged = connectionScopes(ctx) !== null || p.limit !== null || p.after_rev !== null;
    const remaining = h.versions.filter((x) => x.rev > after);
    const selected = paged ? remaining.slice(0, p.limit ?? 2) : remaining;
    const has_more = selected.length < remaining.length;
    const next_after_rev = has_more ? selected.at(-1)!.rev : null;
    const tagOf = await nameTags(ctx.db, ch.tenant_id, selected.map((x) => ({ author_id: x.author_id, session_id: x.session_id, session_kind: x.session_kind })));
    const lines: string[] = [];
    const versions = selected.map((x) => {
      const tag = tagOf(x.author_id, x.session_id, x.session_kind);
      lines.push(`[#${h.msg.seq} r${x.rev} ${hhmm(x.created_at)} @${tag.handle}${tag.kind === "unknown" ? " unknown-author" : ""}${tag.session_kind === "unknown" ? " unknown-session" : ""}${tag.via_assistant ? " via-assistant" : ""}${x.retracted ? " retracted" : ""}]`);
      const body = x.retracted ? "" : x.body;
      const preview = cutText(cleanLines(body), paged ? 600 : Number.MAX_SAFE_INTEGER);
      if (!x.retracted) for (const l of preview.text.split("\n")) lines.push(`  ${l}`);
      if (preview.cut) lines.push("  (preview; full body in structured versions)");
      return { rev: x.rev, seq: x.seq, author: authorJson(tag), body, retracted: x.retracted, created_at: x.created_at };
    });
    lines.push("Revision actors are recorded evidence, not execution authority or consent. Current ownership is separate from a revision's actor.");
    if (next_after_rev !== null) lines.push(`next: chat_history c=${ch.slug} msg=${h.msg.msg_id} after_rev=${next_after_rev}`);
    return {
      tenant_id: ch.tenant_id, identity_id: viewerOf(ctx).identity.id, conversation_id: ch.project_id,
      channel: ch.slug, seq: h.msg.seq, msg_id: h.msg.msg_id,
      current: { rev: h.msg.rev, author_id: h.msg.author_id, retracted: h.msg.retracted },
      versions, has_more, next_after_rev,
      text: plainText(`#${ch.slug} history of #${h.msg.seq} (${versions.length} of ${h.versions.length} versions, current r${h.msg.rev})`, lines),
    };
  },
});

/** Items in channels the caller can still read, named by channel and handle; never message text. */
async function inboxView(ctx: Ctx, page: InboxPage) {
  const { items, head, next_after, has_more } = page;
  const v = viewerOf(ctx);
  const chans = [...(await readableChannels(ctx.db, v, "active")), ...(await readableChannels(ctx.db, v, "archived"))];
  const slug = new Map(chans.map((c) => [c.project_id, c.slug]));
  const dir = await people(ctx.db, v.tenant.id);
  const views: ItemView[] = items.filter((i) => i.kind === "mail" || slug.has(i.conversation_id)).map((i) => ({
    item: i.item_seq, kind: i.kind, channel: i.kind === "mail" ? "mail" : slug.get(i.conversation_id)!,
    conversation_id: i.kind === "mail" ? null : i.conversation_id, seq: i.seq, msg_id: i.msg_id,
    author_id: i.author_id, author: i.author_id === "hub" ? "hub" : dir.get(i.author_id)?.handle ?? "unknown", hop: i.hop, wake: i.wake, created_at: i.created_at,
  }));
  // Keep the raw scan position even if every item is hidden by current channel authorization.
  // An empty visible page need not be the end; never expose filtered message/channel evidence.
  const lines = [...views.map(itemLine), "", `next: after=${next_after} has_more=${has_more}`,
    "Scan cursor only; process originals before acknowledging. head is not a processed cursor."];
  return { tenant_id: v.tenant.id, identity_id: v.identity.id, head, next_after, has_more, items: views,
    text: plainText(`inbox head=${head} (${views.length} shown)`, lines) };
}

/** Authorize/select only the authenticated owner's inbox; never use the prunable retained-row head. */
async function validatedInbox(ctx: Ctx, after: number) {
  const v = viewerOf(ctx);
  const box = inboxStub(ctx.env, v.tenant.id, v.identity.id);
  const high_water = await box.highWater(v.tenant.id, v.identity.id);
  // Separate snapshot/read RPCs are safe under normal monotonic allocation. Refuse, don't clamp or repair.
  if (after > high_water) throw new HubError(409, "conflict", "after exceeds the allocated inbox sequence; reconcile the scan checkpoint before reading or waiting", { high_water });
  return { box, v };
}

export const chatInbox = defineVerb({
  name: "chat.inbox", kind: "query", scope: "tenant", minRole: "reader", freshProofMinutes: null,
  summary: "Your open inbox items, in bounded pages. Continue with next_after even when a permission-filtered page is empty; has_more describes the scan snapshot. Read originals with chat_thread/mail_read before processing. The global head is not a processed cursor. Future after values beyond allocated items are refused.",
  mcp: {
    scope: "read", destructive: false, title: "Inbox", render: chatText,
    input: schema({ after: { type: "integer", minimum: 0, description: "Only items after this item number; continue with next_after from the last scanned page, not the global head. Must not exceed the inbox's allocated sequence (retained head can decrease after pruning)." }, limit: { type: "integer", minimum: 1, maximum: 100, description: "Items to scan before permission filtering, default 50." } }),
  },
  parse: (i) => ({ after: optInt(i, "after", { min: 0, max: Number.MAX_SAFE_INTEGER }) ?? 0, limit: optInt(i, "limit", { min: 1, max: 100 }) ?? 50 }),
  run: async (ctx, p) => {
    const { box, v } = await validatedInbox(ctx, p.after);
    const r = (await box.list(v.tenant.id, v.identity.id, { after: p.after, limit: p.limit, include_acked: false })) as InboxPage;
    return inboxView(ctx, r);
  },
});

export const inboxWait = defineVerb({
  name: "inbox.wait", kind: "query", scope: "tenant", minRole: "reader", freshProofMinutes: null,
  summary: "Wait up to wait_s seconds (at most 20) for an inbox item after the given one, for runners that cannot hold a socket. Future after values beyond allocated items are refused before parking.",
  parse: (i) => ({
    after: optInt(i, "after", { min: 0, max: Number.MAX_SAFE_INTEGER }) ?? 0, limit: optInt(i, "limit", { min: 1, max: 100 }) ?? 50,
    wait_s: optInt(i, "wait_s", { min: 0, max: LIMITS.INBOX_WAIT_MAX_S }) ?? LIMITS.INBOX_WAIT_MAX_S,
  }),
  run: async (ctx, p) => {
    const { box, v } = await validatedInbox(ctx, p.after);
    const r = (await box.wait(v.tenant.id, v.identity.id, { after: p.after, limit: p.limit, wait_ms: p.wait_s * 1000 })) as InboxPage;
    return inboxView(ctx, r);
  },
});

export const inboxAck = defineVerb({
  name: "inbox.ack", kind: "command", scope: "tenant", minRole: "reader", freshProofMinutes: null,
  summary: "Clear explicitly processed inbox items with items (1–100 item numbers), or a fully processed prefix with through. Never combine selectors or clear unseen/skipped items. Acknowledgement is attention only, not execution authority or processing proof.",
  mcp: {
    scope: "write", destructive: false, title: "Acknowledge inbox items", render: chatCommandText, auditKeysOnly: true,
    input: schema({
      through: { type: "integer", minimum: 0, description: "Fully processed prefix, inclusive. Omit when using items. Never acknowledge unseen or skipped items." },
      items: { type: "array", minItems: 1, maxItems: 100, items: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER }, description: "Exact processed inbox item numbers, not message/activity sequences. Use for noncontiguous sources or permission-filtered pages; omit through. Repeated numbers count once." },
    }),
  },
  parse: (i) => {
    if (Object.hasOwn(i, "items")) {
      if (Object.hasOwn(i, "through")) throw badRequest("choose items or through, not both");
      if (!Array.isArray(i.items) || i.items.length < 1 || i.items.length > LIMITS.INBOX_LIMIT_MAX ||
          !i.items.every((n) => typeof n === "number" && Number.isSafeInteger(n) && n >= 1)) {
        throw badRequest("items must be an array of 1–100 positive safe integer inbox item numbers");
      }
      return { items: [...new Set(i.items as number[])], through: null };
    }
    // Preserve the existing API's absent-through no-op; MCP callers should choose an explicit selector.
    return { items: null, through: optInt(i, "through", { min: 0, max: Number.MAX_SAFE_INTEGER }) ?? 0 };
  },
  run: async (ctx, p) => {
    const v = viewerOf(ctx);
    const box = inboxStub(ctx.env, v.tenant.id, v.identity.id);
    return { acked: p.items !== null
      ? await box.ackItems(v.tenant.id, v.identity.id, p.items, ctx.now)
      : await box.ack(v.tenant.id, v.identity.id, p.through!, ctx.now) };
  },
});

export const inboxAckStatus = defineVerb({
  name: "inbox.ack_status", kind: "query", scope: "tenant", minRole: "reader", freshProofMinutes: null,
  summary: "Reconcile exact inbox item attention states without acknowledging. Retained items are open or acked; absent/pruned items are unknown, not proof of acknowledgement. No source details or processing/execution proof; not permission to replay a send or clear skipped attention.",
  mcp: {
    scope: "read", destructive: false, title: "Reconcile inbox acknowledgement", render: chatText, auditKeysOnly: true,
    input: schema({ items: { type: "array", minItems: 1, maxItems: 100, items: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER }, description: "Exact item numbers from the caller's inbox and retained acknowledgement intent, not message/activity sequences. Duplicates return once in first-occurrence order. No prefix selector." } }, ["items"]),
  },
  parse: (i) => {
    if (Object.hasOwn(i, "through")) throw badRequest("acknowledgement status requires exact items, not through");
    if (!Array.isArray(i.items) || i.items.length < 1 || i.items.length > LIMITS.INBOX_LIMIT_MAX ||
        !i.items.every((n) => typeof n === "number" && Number.isSafeInteger(n) && n >= 1)) {
      throw badRequest("items must be an array of 1–100 positive safe integer inbox item numbers");
    }
    return { items: [...new Set(i.items as number[])] };
  },
  run: async (ctx, p) => {
    const v = viewerOf(ctx);
    const items = await inboxStub(ctx.env, v.tenant.id, v.identity.id).ackStatus(v.tenant.id, v.identity.id, p.items);
    return { tenant_id: v.tenant.id, identity_id: v.identity.id, items,
      text: plainText("Inbox acknowledgement states", [
        ...items.map(i => `item=${i.item} state=${i.state}${i.acked_at === null ? "" : ` acked_at=${i.acked_at}`}`),
        "Attention snapshot only, not processing or execution proof. Unknown includes absent/pruned items; reconcile originals and retained outcomes, never infer acknowledgement or permission to resend.",
      ]) };
  },
});

export const chatReadStatus = defineVerb({
  name: "chat.read_status", kind: "query", scope: "tenant", minRole: "reader", freshProofMinutes: null,
  summary: "Reconcile your saved read cursor in one currently readable channel without advancing it. Null means no saved cursor, distinct from zero. An out-of-head cursor is reported, never repaired. Cursor state is not processing or execution proof, an operation receipt or permission to retry.",
  mcp: {
    scope: "read", destructive: false, title: "Reconcile channel read cursor", render: chatText, auditKeysOnly: true,
    input: schema({ c: C }, ["c"]),
  },
  parse: (i) => ({ c: channelParam(i) }),
  run: async (ctx, p) => {
    const v = viewerOf(ctx);
    // Current channel permission precedes both snapshots; never disclose stored cursors for denied channels.
    const ch = await readableChannel(ctx, p.c);
    const head = await conversationStub(ctx.env, ch.tenant_id, ch.project_id).head(ch.tenant_id, ch.project_id);
    const read_seq = await inboxStub(ctx.env, v.tenant.id, v.identity.id).readCursor(v.tenant.id, v.identity.id, ch.project_id);
    const ahead_of_head = read_seq !== null && read_seq > head;
    // Separate stores, not an atomic operation receipt. Concurrent marking can exceed this earlier head snapshot.
    return { tenant_id: v.tenant.id, identity_id: v.identity.id, conversation_id: ch.project_id,
      channel: ch.slug, head, read_seq, ahead_of_head,
      text: plainText(`#${ch.slug} saved read cursor`, [
        `head=${head} read_seq=${read_seq === null ? "absent" : read_seq} ahead_of_head=${ahead_of_head}`,
        "Separate head/cursor snapshots, not processing or execution proof or an operation receipt. Reconcile retained decisions and originals; no automatic retry, advance or repair.",
      ]) };
  },
});

export const chatMarkRead = defineVerb({
  name: "chat.mark_read", kind: "command", scope: "tenant", minRole: "reader", freshProofMinutes: null,
  summary: "Move your durable read cursor in an authorized channel forward to seq (it never moves back). Future sequences above the current channel head are refused. Explicitly mark only processed activity; reads do not move cursors.",
  mcp: {
    scope: "write", destructive: false, title: "Mark channel activity read", render: chatCommandText,
    input: schema({ c: C, seq: { type: "integer", minimum: 0, description: "Last processed activity cursor, at most the current channel head; do not skip omitted messages." } }, ["c", "seq"]),
  },
  parse: (i) => ({ c: channelParam(i), seq: optInt(i, "seq", { min: 0, max: Number.MAX_SAFE_INTEGER }) ?? 0 }),
  run: async (ctx, p) => {
    const v = viewerOf(ctx);
    const ch = await readableChannel(ctx, p.c);
    // Validate against this authorized conversation, not its inbox (which only contains selected wakes).
    // The head is monotonic during normal operation: activity committed after this snapshot cannot be skipped.
    // Refuse rather than clamp; a guessed future cursor must not acknowledge unseen current activity either.
    const head = await conversationStub(ctx.env, ch.tenant_id, ch.project_id).head(ch.tenant_id, ch.project_id);
    if (p.seq > head) throw new HubError(409, "conflict", "seq exceeds the current channel head; read and process activity before marking it read", { head });
    return { channel: ch.slug, read_seq: await inboxStub(ctx.env, v.tenant.id, v.identity.id).markRead(v.tenant.id, v.identity.id, ch.project_id, p.seq) };
  },
});

export const refBacklinks = defineVerb({
  name: "ref.backlinks", kind: "query", scope: "tenant", minRole: "reader", freshProofMinutes: null,
  summary: "Where a commit, ticket, session, or message was discussed, in channels you can read, newest first. Keys use message syntax: site#k7q2, site@3f9a2c1, a session id, general/412.",
  mcp: {
    scope: "read", destructive: false, title: "Where was this discussed", render: chatText,
    input: schema({
      kind: { type: "string", enum: ["commit", "ticket", "session", "msg"], description: "What the key names." },
      key: { type: "string", description: "For example site#k7q2 or site@3f9a2c1." },
      limit: { type: "integer", minimum: 1, maximum: 50, description: "Messages, default 20." },
    }, ["kind", "key"]),
  },
  parse: (i) => ({ kind: reqEnum(i, "kind", ["commit", "ticket", "session", "msg"] as const), key: reqString(i, "key", { max: 128 }), limit: optInt(i, "limit", { min: 1, max: 50 }) ?? 20 }),
  run: async (ctx, p) => {
    const v = viewerOf(ctx);
    let target: { kind: RefKind; key: string; prefix: boolean } | null = backlinkTarget(p.kind, p.key);
    if (p.kind === "msg") {
      const parsed = parseRefText("msg", p.key);
      const hit = parsed ? (await resolveRefs(ctx, [parsed])).resolved[0] : undefined;
      target = hit ? { kind: "msg", key: hit.key, prefix: false } : null;
    }
    if (!target) return { target: null, items: [], text: plainText(`backlinks ${p.kind}: no such reference`, []) };
    const dir = await people(ctx.db, v.tenant.id);
    const items = (await backlinks(ctx.db, v, target, p.limit)).map((b) => ({
      channel: b.channel, seq: b.seq, msg_id: b.msg_id, author: dir.get(b.author_id)?.handle ?? "unknown", created_at: b.created_at,
    }));
    return {
      target, items,
      text: plainText(`backlinks ${target.kind} ${target.key}: ${items.length} messages`, items.map((x) => `[#${x.channel} #${x.seq} ${hhmm(x.created_at)} @${x.author}]`)),
    };
  },
});
