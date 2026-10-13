#!/usr/bin/env node
// Node 22+, no packages. Credentials stay in a file, never URLs or argv.
import { readFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { randomBytes, createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { once } from 'node:events';

const origin = new URL(process.env.PIMWELL_ORIGIN || 'https://mcc.pimwell.com');
if (origin.username || origin.password) throw Error('Credentials must not be in the origin URL');
if (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(origin.hostname))) throw Error('HTTPS required');
const token = (await readFile(process.env.PIMWELL_TOKEN_FILE || `${process.env.HOME}/.config/pimwell/mcc.token`, 'utf8')).trim();
const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
let offset = Number(process.env.PIMWELL_OFFSET || 0), socket, stopped = false, lastSeen = Date.now();
if (!Number.isSafeInteger(offset) || offset < 0) throw Error('Invalid PIMWELL_OFFSET');
const output = async frame => { if (!process.stdout.write(JSON.stringify(frame) + '\n')) await once(process.stdout, 'drain'); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function http(method, params) {
  const url = new URL(`/chat/v1/${method}`, origin);
  const reading = method.startsWith('get');
  if (reading) for (const [k, v] of Object.entries(params)) url.searchParams.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  const res = await fetch(url, { method: reading ? 'GET' : 'POST', headers, redirect: 'error',
    ...(!reading && { body: JSON.stringify(params) }), signal: AbortSignal.timeout(60000) });
  return res.json();
}
async function receive(frame) {
  lastSeen = Date.now();
  await output(frame);
  if (!frame.request_id && frame.ok && frame.result?.next_offset !== undefined) offset = frame.result.next_offset;
  if (!frame.ok && ['offset_expired', 'invalid_offset', 'unauthorized', 'forbidden'].includes(frame.error?.code)) {
    // Resync is a harness decision. Never silently discard retained activity.
    stopped = true; socket?.destroy(); process.exitCode = 1;
  }
}
function sendFrame(value, opcode = 1) {
  const data = Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
  if (data.length > 65536) throw Error('Frame too large');
  const prefix = Buffer.alloc(data.length < 126 ? 2 : data.length <= 65535 ? 4 : 10);
  prefix[0] = 0x80 | opcode;
  prefix[1] = 0x80 | (data.length < 126 ? data.length : data.length <= 65535 ? 126 : 127);
  if (prefix.length === 4) prefix.writeUInt16BE(data.length, 2);
  if (prefix.length === 10) prefix.writeBigUInt64BE(BigInt(data.length), 2);
  const mask = randomBytes(4);
  for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
  socket.write(Buffer.concat([prefix, mask, data]));
}
async function connect() {
  const key = randomBytes(16).toString('base64');
  const url = new URL(`/chat/v1/ws?offset=${offset}`, origin);
  const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, { headers: {
    ...headers, upgrade: 'websocket', connection: 'Upgrade', 'sec-websocket-version': '13', 'sec-websocket-key': key,
  } });
  await new Promise((resolve, reject) => {
    req.setTimeout(10000, () => req.destroy(Error('Upgrade timeout')));
    req.on('error', reject);
    req.on('response', res => { res.resume(); reject(Error(`Upgrade refused (${res.statusCode})`)); });
    req.on('upgrade', (res, stream, head) => {
      const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      if (res.headers['sec-websocket-accept'] !== accept) { stream.destroy(); reject(Error('Invalid upgrade')); return; }
      req.setTimeout(0); socket = stream; lastSeen = Date.now();
      let buffer = Buffer.alloc(0), fragments = [], fragmentSize = 0, jobs = Promise.resolve();
      function data(chunk) {
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= 2) {
          const final = !!(buffer[0] & 128), opcode = buffer[0] & 15;
          let length = buffer[1] & 127, start = 2;
          if (length === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(2); start = 4; }
          if (length === 127) { if (buffer.length < 10) return; const n = buffer.readBigUInt64BE(2); if (n > 1048576n) return stream.destroy(); length = Number(n); start = 10; }
          if (length > 1048576 || (buffer[1] & 128) || (buffer[0] & 112)) return stream.destroy();
          if (buffer.length < start + length) return;
          const payload = buffer.subarray(start, start + length); buffer = buffer.subarray(start + length);
          if (opcode === 8) { stream.destroy(); return; }
          if (opcode === 9) { sendFrame(payload, 10); continue; }
          if (opcode === 10) continue;
          if (![0, 1].includes(opcode)) return stream.destroy();
          fragments.push(payload); fragmentSize += payload.length;
          if (fragmentSize > 1048576) return stream.destroy();
          if (final) {
            const text = Buffer.concat(fragments).toString(); fragments = []; fragmentSize = 0;
            jobs = jobs.then(() => receive(JSON.parse(text))).catch(() => { stream.destroy(); });
          }
        }
      }
      stream.on('data', data); stream.on('error', () => {});
      if (head.length) data(head);
      resolve();
    });
    req.end();
  });
}
// stdin is protocol command JSON, not arbitrary text or execution instructions.
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
(async () => {
  for await (const line of input) {
    if (!line.trim()) continue;
    let command;
    try {
      command = JSON.parse(line);
      if (typeof command.method !== 'string' || !command.params || typeof command.params !== 'object') throw Error();
    } catch { await output({ ok: false, error: { code: 'invalid_stdin' } }); continue; }
    command.request_id ||= randomBytes(8).toString('hex');
    try {
      if (socket && !socket.destroyed) sendFrame(command);
      else await receive({ ...await http(command.method, command.params), request_id: command.request_id });
    } catch {
      // An accepted mutation may have lost its response. Never replay automatically.
      await output({ request_id: command.request_id, ok: false, error: { code: 'ambiguous_delivery' } });
    }
  }
})().catch(() => { stopped = true; process.exitCode = 1; });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { stopped = true; socket?.destroy(); input.close(); process.exit(0); });
let failures = 0;
while (!stopped) {
  try {
    if (process.env.PIMWELL_POLL_ONLY !== '1') {
      await connect(); failures = 0;
      const heartbeat = setInterval(() => {
        if (Date.now() - lastSeen > 90000) socket.destroy();
        else if (!socket.destroyed) sendFrame({ type: 'ping' });
      }, 30000);
      try { await once(socket, 'close'); } finally { clearInterval(heartbeat); socket?.destroy(); socket = undefined; }
    } else throw Error('Polling requested');
  } catch { process.stderr.write('Socket unavailable; using getUpdates.\n'); }
  if (stopped) break;
  try { await receive(await http('getUpdates', { offset, timeout: 50, limit: 100 })); }
  catch { process.stderr.write('Update request failed.\n'); }
  if (!stopped) await sleep(Math.min(30000, 1000 * 2 ** Math.min(failures++, 5)) * (0.5 + Math.random()));
}
input.close();
