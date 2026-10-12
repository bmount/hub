// Release credentials are separate from Cloudflare's token and never sent to Cloudflare.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export async function deployRecorder(project, { fetchImpl = fetch, tokenFile = process.env.PIMWELL_TOKEN_FILE ?? join(homedir(), '.config/pimwell/mcc.token'), origin = process.env.PIMWELL_ORIGIN ?? 'https://mcc.pimwell.com' } = {}) {
  const url = new URL(origin);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/') throw new Error('Pimwell origin must be an HTTPS origin');
  const token = readFileSync(tokenFile, 'utf8').trim();
  async function call(verb, input) {
    const r = await fetchImpl(new URL(`/api/${verb}`, url), { method: 'POST', redirect: 'error',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(input), signal: AbortSignal.timeout(30000) });
    const j = await r.json();
    if (!r.ok || !j.ok) throw new Error(`Pimwell ${verb} refused (HTTP ${r.status}); deployment may already be live; inspect the local release record`);
    return j.result;
  }
  // Refuse missing/invalid reporting credentials before uploading or deploying anything.
  const caller = await call('whoami', {});
  if (!caller.identity?.email || !['member', 'admin'].includes(caller.tenant?.role)) throw new Error('Pimwell reporting member identity missing');
  return async (target, commit) => call('deploy.record', { project, commit, worker: target.worker,
    version: target.version, deployment: target.deployment, deployed_at: target.deployed_at,
    triggered_by: caller.identity.email, message: 'make release' });
}
