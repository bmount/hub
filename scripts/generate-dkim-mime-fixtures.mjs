// Offline, disposable synthetic keys only; no provider credentials or DNS.
import { generateKeyPairSync } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { dkimSign } from 'mailauth/lib/dkim/sign.js';
const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const ed = generateKeyPairSync('ed25519');
const now = '2026-10-09T07:00:00.000Z';
const headers = ['from', 'to', 'subject', 'date', 'message-id', 'mime-version', 'content-type', 'content-transfer-encoding',
  'content-id', 'content-description', 'content-language', 'content-x-extension'];
const raw = 'From: Member <member@example.com>\r\nTo: org.agent@pimwell.test\r\nSubject: MIME coverage\r\nDate: Fri, 09 Oct 2026 07:00:00 +0000\r\nMessage-ID: <mime-coverage@example.com>\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 7bit\r\nCoNtEnT-ID: <part@example.com>\r\nContent-Description: Signed\r\n\tattachment description\r\nContent-Language: en\r\nContent-X-Extension: signed extension\r\n\r\nOriginal body.\r\n';
const record = (key, algorithm) => `v=DKIM1; k=${algorithm}; p=${(algorithm === 'ed25519'
  ? key.export({ type: 'spki', format: 'der' }).subarray(-32)
  : key.export({ type: 'spki', format: 'der' })).toString('base64')}`;
const fixtures = { now, raw, record: record(rsa.publicKey, 'rsa'), edRecord: record(ed.publicKey, 'ed25519') };
async function signature(key, algorithm, headerList) {
  const result = await dkimSign(raw, { signTime: now, headerList,
    signatureData: [{ signingDomain: 'example.com', selector: algorithm === 'ed25519-sha256' ? 'ed' : 'rsa',
      privateKey: key.export({ type: 'pkcs8', format: 'pem' }), algorithm }] });
  if (result.errors.length || !result.signatures) throw new Error('Synthetic fixture signing failed');
  return result.signatures;
}
fixtures.valid = await signature(rsa.privateKey, 'rsa-sha256', headers) + raw;
fixtures.ed25519 = await signature(ed.privateKey, 'ed25519-sha256', headers) + raw;
fixtures.unsignedMime = await signature(rsa.privateKey, 'rsa-sha256', headers.filter(h => !['content-id', 'content-description', 'content-language', 'content-x-extension'].includes(h))) + raw;
// Both independently pass crypto, but neither covers every semantic field.
fixtures.splitCoverage = await signature(rsa.privateKey, 'rsa-sha256', headers.filter(h => h !== 'content-description'))
  + await signature(ed.privateKey, 'ed25519-sha256', headers.filter(h => h !== 'content-id')) + raw;
// Incomplete first signature must not hide a later complete aligned signature.
fixtures.laterComplete = await signature(rsa.privateKey, 'rsa-sha256', headers.filter(h => h !== 'content-description'))
  + await signature(ed.privateKey, 'ed25519-sha256', headers) + raw;
writeFileSync(new URL('../test/fixtures/dkim-mime.json', import.meta.url), JSON.stringify(fixtures, null, 2) + '\n');
