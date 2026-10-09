// Offline disposable test key; never writes private keys or calls real DNS.
import { generateKeyPairSync } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { dkimSign } from 'mailauth/lib/dkim/sign.js';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const now = '2026-10-09T04:00:00.000Z';
const fixtures = { now, record: `v=DKIM1; k=rsa; p=${publicKey.export({ type: 'spki', format: 'der' }).toString('base64')}` };
for (const [name, from, id, body, to = 'ingress.helper@pimwell.test', cc = 'copied@example.com', subject = name] of [
  ['first', 'member@example.com', 'first', 'Original body.'],
  ['second', 'member@example.com', 'second', 'Subsequent message.'],
  ['third', 'member@example.com', 'third', 'Another message.'],
  ['other', 'other@example.com', 'other', 'Other human.'],
  ['forwarded', 'member@example.com', 'forwarded', '---------- Forwarded message ----------\r\nFrom: stranger@example.com\r\nEvidence only.'],
  ['outProject', 'pat@example.com', 'project', 'Hello', 'acme.site@pimwell.test', '', 'Prices'],
  ['outAgent', 'pat@example.com', 'agent', 'Hello', 'acme.scout@pimwell.test', '', 'For the agent'],
  ['outCopied', 'pat@example.com', 'copied', 'Hello', 'acme.scout@pimwell.test', 'kim@example.com, outside@example.org', 'Launch plan'],
]) {
  const raw = `From: Member <${from}>\r\nTo: ${to}\r\n${cc ? `Cc: ${cc}\r\n` : ''}Subject: ${subject}\r\nDate: Fri, 09 Oct 2026 04:00:00 +0000\r\nMessage-ID: <${id}@example.com>\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 7bit\r\n\r\n${body}\r\n`;
  const signed = await dkimSign(raw, { signatureData: [{ signingDomain: 'example.com', selector: 'test', privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }) }],
    signTime: now, headerList: ['from', 'to', 'cc', 'subject', 'date', 'message-id', 'mime-version', 'content-type', 'content-transfer-encoding'] });
  if (signed.errors.length || !signed.signatures) throw new Error('Fixture signing failed');
  fixtures[name] = signed.signatures + raw;
}
writeFileSync(new URL('../test/fixtures/mail-ingress.json', import.meta.url), JSON.stringify(fixtures, null, 2) + '\n');
