// Offline, disposable test key only. No real mailbox credentials or DNS calls.
import { generateKeyPairSync } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { dkimSign } from 'mailauth/lib/dkim/sign.js';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
const record = `v=DKIM1; k=rsa; p=${publicKey.export({ type: 'spki', format: 'der' }).toString('base64')}`;
const now = '2026-10-09T04:00:00.000Z';
const raw = 'From: Member <member@example.com>\r\nTo: org.agent@pimwell.test\r\nCc: copied@example.com\r\nSubject: Signed fixture\r\nDate: Fri, 09 Oct 2026 04:00:00 +0000\r\nMessage-ID: <dkim-fixture@example.com>\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 7bit\r\n\r\nOriginal body.\r\n';
const fixtures = { now, record, raw };
const ed = generateKeyPairSync('ed25519');
fixtures.edRecord = `v=DKIM1; k=ed25519; p=${ed.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64')}`;
for (const [name, options] of Object.entries({
  valid: {},
  ed25519: { signatureData: [{ signingDomain: 'example.com', selector: 'test', privateKey: ed.privateKey.export({ type: 'pkcs8', format: 'pem' }), algorithm: 'ed25519-sha256' }] },
  unaligned: { signatureData: [{ signingDomain: 'other.example', selector: 'test', privateKey: pem }] },
  expired: { expires: '2026-10-09T04:01:00.000Z' },
  future: { signTime: '2026-10-10T04:00:00.000Z' },
  limited: { signatureData: [{ signingDomain: 'example.com', selector: 'test', privateKey: pem, maxBodyLength: 0 }] },
  limitedFull: { signatureData: [{ signingDomain: 'example.com', selector: 'test', privateKey: pem, maxBodyLength: 16 }] },
  unsignedCc: { headerList: ['from', 'to', 'subject', 'date', 'message-id', 'mime-version', 'content-type', 'content-transfer-encoding'] },
})) {
  const result = await dkimSign(raw, { signatureData: [{ signingDomain: 'example.com', selector: 'test', privateKey: pem }],
    signTime: now, headerList: ['from', 'to', 'cc', 'subject', 'date', 'message-id', 'mime-version', 'content-type', 'content-transfer-encoding'], ...options });
  if (result.errors.length || !result.signatures) throw new Error(`Fixture ${name} failed`);
  fixtures[name] = result.signatures + raw;
}
writeFileSync(new URL('../test/fixtures/dkim.json', import.meta.url), JSON.stringify(fixtures, null, 2) + '\n');
