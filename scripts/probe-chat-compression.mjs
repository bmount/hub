#!/usr/bin/env node
// Opt-in live probe. Use only an owned throwaway channel; never retries a mutation.
import WebSocket from 'ws';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
const origin = new URL(process.env.PIMWELL_ORIGIN || 'https://mcc.pimwell.com');
if (origin.username || origin.password || (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(origin.hostname)))) throw Error('Credential-free HTTPS origin required (HTTP allowed only on loopback)');
const channel = process.env.PIMWELL_CHANNEL;
if (!channel?.startsWith('tmp-')) throw Error('PIMWELL_CHANNEL must be a throwaway tmp- channel');
const dir = process.env.PIMWELL_CAPTURE_DIR;
if (!dir) throw Error('PIMWELL_CAPTURE_DIR required');
await mkdir(dir, { recursive: true, mode: 0o700 });
if (process.argv.includes('--roots')) {
  const capture = JSON.parse(await readFile(`${dir}/capture.json`, 'utf8'));
  const ids = capture.commands.map(row => row.ack?.server_request_id).filter(Boolean);
  if (!ids.length || ids.some(id => !/^[0-9a-f-]{36}$/.test(id))) throw Error('Invalid root identifiers');
  const account = (await readFile(process.env.PIMWELL_ACCOUNT_ID_FILE, 'utf8')).trim();
  if (!/^[a-f0-9]{32}$/.test(account)) throw Error('Invalid account id');
  const analyticsToken = (await readFile(process.env.PIMWELL_ANALYTICS_TOKEN_FILE, 'utf8')).trim();
  const query = `SELECT blob3 AS version, blob6 AS request_id, blob8 AS route, double1 AS ms FROM pimwell_perf WHERE timestamp > NOW() - INTERVAL '2' HOUR AND blob7 = 'request' AND blob6 IN (${ids.map(id => `'${id}'`).join(',')}) LIMIT 1000`;
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/analytics_engine/sql`, { method: 'POST', headers: { authorization: `Bearer ${analyticsToken}` }, body: query, signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw Error(`Analytics query failed (${response.status})`);
  const roots = await response.json();
  const joined = new Set((roots.data || []).filter(row => row.route === 'do.handler.Inbox.webSocketMessage' && row.ms > 0).map(row => row.request_id));
  const report = { commands: capture.commands.length, root_joins: ids.filter(id => joined.has(id)).length, roots };
  await writeFile(`${dir}/roots.json`, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ commands: report.commands, root_joins: report.root_joins }));
  process.exit(report.root_joins / report.commands >= .95 ? 0 : 1);
}
// Refuse to replace prior evidence, even if an operator repeats the invocation.
await writeFile(`${dir}/capture.json`, JSON.stringify({ commands: [], automatic_resubmissions: 0 }), { flag: 'wx', mode: 0o600 });
const token = (await readFile(process.env.PIMWELL_TOKEN_FILE || `${process.env.HOME}/.config/pimwell/mcc.token`, 'utf8')).trim();
const sessionResponse = await fetch(new URL('/api/session.start', origin), { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ label: 'tmp-259 compressed probe', ttl: 7200 }) });
const session = await sessionResponse.json();
if (!sessionResponse.ok || !session.result?.session_token) throw Error('Unable to start probe session');
const headers = { authorization: `Bearer ${session.result.session_token}`, 'content-type': 'application/json' };
const capture = { commands: [], frames: [], wire: [], automatic_resubmissions: 0 };
const save = () => writeFile(`${dir}/capture.json`, JSON.stringify(capture, null, 2), { mode: 0o600 });
async function api(method, params) {
  const res = await fetch(new URL(`/api/${method}`, origin), { method: 'POST', headers, body: JSON.stringify(params), signal: AbortSignal.timeout(60000) });
  const json = await res.json();
  if (!res.ok) throw Error(JSON.stringify(json));
  return json.result ?? json;
}
const discovery = await fetch(new URL('/chat/v1/getChats', origin), { headers }).then(r => r.json());
const conversation = discovery.result.conversations.find(c => c.channel === channel);
if (!conversation) throw Error('Channel not readable');
const url = new URL('/chat/v1/ws?offset=0', origin); url.protocol = origin.protocol === 'https:' ? 'wss:' : 'ws:';
const ws = new WebSocket(url, { headers, perMessageDeflate: true });
let resolveReady, rejectReady;
const ready = new Promise((r, j) => { resolveReady = r; rejectReady = j; });
const pending = new Map();
ws.on('upgrade', res => {
  capture.upgrade = { ray: res.headers['cf-ray'], extensions: res.headers['sec-websocket-extensions'] };
  // Record actual frame boundaries/RSV1, not just extension negotiation.
  const socket = res.socket, write = socket.write;
  let wire = Buffer.alloc(0);
  socket.write = function(data, ...args) {
    wire = Buffer.concat([wire, Buffer.from(data)]);
    while (wire.length >= 2) {
      let size = wire[1] & 127, start = 2;
      if (size === 126) { if (wire.length < 4) break; size = wire.readUInt16BE(2); start = 4; }
      if (size === 127) { if (wire.length < 10) break; size = Number(wire.readBigUInt64BE(2)); start = 10; }
      const total = start + (wire[1] & 128 ? 4 : 0) + size;
      if (wire.length < total) break;
      if ((wire[0] & 15) === 1) capture.wire.push({ at: Date.now(), compressed: !!(wire[0] & 64), bytes: total });
      wire = wire.subarray(total);
    }
    return write.call(this, data, ...args);
  };
});
ws.on('message', data => {
  const frame = JSON.parse(data); capture.frames.push(frame);
  if (frame.type === 'connected') resolveReady();
  // Fault injection is receiver-side only: the server still sees exactly one send.
  if (process.env.PIMWELL_DROP_ACK !== '1') pending.get(frame.request_id)?.(frame);
});
ws.on('error', error => { capture.error = error.message; rejectReady(error); });
ws.on('close', (code, reason) => { capture.close = { code, reason: reason.toString() }; rejectReady(Error('closed before ready')); });
try {
  await Promise.race([ready, new Promise((_, reject) => setTimeout(() => reject(Error('Connect timeout')), 15000).unref())]);
  if (!ws.extensions.includes('permessage-deflate')) throw Error('Compression not negotiated');
  let after = (await api('chat.read', { c: channel, limit: 1 })).head;
  const roots = [];
  for (let i = 0; i < Number(process.env.PIMWELL_COUNT || 100); i++) {
    const command = { request_id: randomUUID(), method: 'sendMessage', params: { chat: { id: conversation.id, kind: 'channel' }, text: `tmp-259 compressed ${i} ${randomUUID()}`, after, client_id: randomUUID(), ...(i >= 8 ? { reply_to: roots[(i - 8) % 8] } : {}) } };
    const row = { command, started: Date.now() }; capture.commands.push(row);
    await save(); // Exact intent reaches disk before any socket write.
    const ack = new Promise(resolve => pending.set(command.request_id, resolve));
    ws.send(JSON.stringify(command), { compress: true }, error => { row.flushed = Date.now(); if (error) row.send_error = error.message; });
    const frame = await Promise.race([ack, new Promise(resolve => setTimeout(() => resolve(null), Number(process.env.PIMWELL_ACK_TIMEOUT_MS || 30000)).unref())]);
    pending.delete(command.request_id);
    row.ack = frame; row.elapsed = Date.now() - row.started;
    // Both success and ambiguity reconcile read-only; no command is resubmitted.
    row.reconciliation = await api('chat.post_status', { c: channel, idempotency_key: command.params.client_id, intent: { body: command.params.text, ...(command.params.reply_to ? { reply_to: command.params.reply_to } : {}) } });
    await save();
    console.log(JSON.stringify({ index: i, elapsed: row.elapsed, acknowledged: !!frame, root: frame?.server_request_id, recorded: !!row.reconciliation.record }));
    if (!frame?.ok) break;
    if (i < 8) roots.push(frame.result.msg_id);
    after = frame.result.head;
    await new Promise(resolve => setTimeout(resolve, Number(process.env.PIMWELL_INTERVAL_MS || 10500)));
  }
} finally {
  ws.terminate(); await save();
}
capture.summary = { commands: capture.commands.length, joins: capture.commands.filter(r => r.ack?.ok && r.ack?.server_request_id && r.ack?.request_id === r.command.request_id).length, compressed_frames: capture.wire.filter(f => f.compressed).length };
await save(); console.log(JSON.stringify(capture.summary));
if (process.env.PIMWELL_DROP_ACK === '1') {
  if (capture.commands.length !== 1 || capture.commands[0].ack !== null || capture.commands[0].reconciliation.intent_check?.matches !== true) process.exitCode = 1;
} else if (capture.summary.commands !== Number(process.env.PIMWELL_COUNT || 100) || capture.summary.joins / capture.summary.commands < .95 || capture.summary.compressed_frames < capture.summary.commands) process.exitCode = 1;
