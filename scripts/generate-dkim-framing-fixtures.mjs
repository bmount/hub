// Offline disposable keys only. No mailbox credentials, network or custom crypto.
import { generateKeyPairSync } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { dkimSign } from 'mailauth/lib/dkim/sign.js';
const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const ed = generateKeyPairSync('ed25519');
const now = '2026-10-09T07:00:00.000Z';
const headerList = ['from', 'to', 'subject', 'date', 'message-id', 'mime-version', 'content-type', 'content-transfer-encoding'];
const raw = 'From: Member <member@example.com>\r\nTo: org.agent@pimwell.test\r\nSubject: Signed\tframing café\r\n\tcontinued subject\r\nDate: Fri, 09 Oct 2026 07:00:00 +0000\r\nMessage-ID: <framing@example.com>\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 7bit\r\n\r\nOriginal body.\r\n';
const fixtures = { now, raw,
  record: `v=DKIM1; k=rsa; p=${rsa.publicKey.export({ type: 'spki', format: 'der' }).toString('base64')}`,
  edRecord: `v=DKIM1; k=ed25519; p=${ed.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64')}` };
async function sign(bytes, key = rsa.privateKey, algorithm = 'rsa-sha256') {
  const result = await dkimSign(Buffer.from(bytes), { signTime: now, headerList,
    signatureData: [{ signingDomain: 'example.com', selector: algorithm === 'ed25519-sha256' ? 'ed' : 'rsa',
      privateKey: key.export({ type: 'pkcs8', format: 'pem' }), algorithm }] });
  if (result.errors.length || !result.signatures) throw new Error('Synthetic fixture signing failed');
  return result.signatures + bytes;
}
fixtures.valid = await sign(raw);
fixtures.ed25519 = await sign(raw, ed.privateKey, 'ed25519-sha256');
fixtures.controlSubject = await sign(raw.replace('Signed\tframing', 'Signed\u000bframing'));
fixtures.controlFold = await sign(raw.replace('continued subject', 'continued\u000csubject'), ed.privateKey, 'ed25519-sha256');
// Not semantic authority, but malformed outer framing must still be refused.
fixtures.controlExtension = await sign('X-Evidence: invalid\u007fvalue\r\n' + raw);
// Header framing policy must not inspect or alter the signed body bytes.
fixtures.bodyControls = await sign(raw + '\u0000\u0008\u000b\u000c\u001f\u007f\r\n');
writeFileSync(new URL('../test/fixtures/dkim-framing.json', import.meta.url), JSON.stringify(fixtures, null, 2) + '\n');
