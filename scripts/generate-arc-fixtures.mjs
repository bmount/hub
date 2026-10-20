// Disposable offline keys; never production credentials.
import { generateKeyPairSync } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { createSeal } from 'mailauth/lib/arc/index.js';
import { dkimSign } from 'mailauth/lib/dkim/sign.js';
const pair = generateKeyPairSync('rsa', { modulusLength: 1024 });
const privateKey = pair.privateKey.export({ type: 'pkcs8', format: 'pem' });
const now = '2026-10-20T21:00:00.000Z';
const raw = 'From: Brian <member@example.com>\r\nTo: org.agent@pimwell.test\r\nSubject: ARC fixture\r\nDate: Tue, 20 Oct 2026 21:00:00 +0000\r\nMessage-ID: <arc-fixture@example.com>\r\n\r\nHello.\r\n';
const record = `v=DKIM1; k=rsa; p=${pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64')}`;
const fixtures = { now, raw, record };
for (const [name, signingDomain, authResults] of [
  ['valid', 'email.cloudflare.net', 'mx.cloudflare.net; dmarc=pass header.from=example.com'],
  ['untrusted', 'attacker.example', 'mx.cloudflare.net; dmarc=pass header.from=example.com'],
  ['misaligned', 'email.cloudflare.net', 'mx.cloudflare.net; dmarc=pass header.from=other.example'],
  ['wrongAuthserv', 'email.cloudflare.net', 'attacker.example; dmarc=pass header.from=example.com'],
]) {
  const sealed = await createSeal(raw, { strict: true, seal: { signingDomain, selector: 'test', privateKey,
    signTime: now, authResults, headerList: ['from', 'to', 'subject', 'date', 'message-id'] } });
  if (sealed.errors.length) throw new Error('ARC fixture failed');
  fixtures[name] = sealed.headers.join('\r\n') + '\r\n' + raw;
}
for (const [name, message] of [
  ['validChain', fixtures.untrusted],
  ['untrustedHigher', fixtures.valid],
  ['sealedActions', raw.replace('org.agent@pimwell.test', 'actiontest.space@pimwell.test').replace('Hello.', 'add Jane Doe, CEO of Acme, introduced by Bob; attach the deck')],
]) {
  const sealed = await createSeal(message, { strict: true, seal: { signingDomain: name === 'untrustedHigher' ? 'attacker.example' : 'email.cloudflare.net', selector: 'test', privateKey,
    signTime: now, cv: name === 'sealedActions' ? 'none' : 'pass', authResults: 'mx.cloudflare.net; dmarc=pass header.from=example.com',
    headerList: ['from', 'to', 'subject', 'date', 'message-id'] } });
  if (sealed.errors.length) throw new Error('Chained fixture failed');
  fixtures[name] = sealed.headers.join('\r\n') + '\r\n' + message;
}
const signed = await dkimSign(raw, { signTime: now, headerList: ['from', 'subject', 'date', 'message-id'],
  signatureData: [{ signingDomain: 'example.com', selector: 'test', privateKey }] });
fixtures.m365 = signed.signatures + raw;
writeFileSync(new URL('../test/fixtures/arc.json', import.meta.url), JSON.stringify(fixtures, null, 2) + '\n');
