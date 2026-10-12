#!/usr/bin/env node
// `make release`: put the current main into production (the hub, the Git proxy and the tail Worker). Pushing never deploys; releasing is this separate step, for
// whoever holds the deploy token (scripts/cf/with-deploy-token.sh supplies it). It tests the exact commit, uploads a
// version that keeps the dashboard's vars, refuses binding or runtime changes, records the rollback version, deploys
// and smoke-checks. Logs and a record go to $RELEASE_DIR/<commit>/ (default ~/.local/state/pimwell/releases).
import { spawnSync } from 'node:child_process';
import { deployRecorder } from './deploy-record.mjs';
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Pimwell's Workers ship together from the same commit: the hub, the Git proxy (shares src/) and the tail Worker that forwards logs to the hub.
const WORKERS = [{ name: 'pimwell-hub', config: 'wrangler.jsonc' }, { name: 'pimwell-git', config: 'git-proxy/wrangler.jsonc' }, { name: 'pimwell-tail', config: 'tail/wrangler.jsonc' }];
const SMOKE = [['https://pimwell.com/', 200], ['https://pimwell.com/login', 200], ['https://pimwell.com/healthz', 200],
  ['https://mcc.pimwell.com/setup', 200], ['https://mcc.pimwell.com/.well-known/oauth-protected-resource/mcp', 200],
  ['https://mcc.pimwell.com/mail', 404], ['https://mcc.pimwell.com/agent/mcp', 401],
  ['https://mcc.pimwell.com/pimwell.git/info/refs?service=git-upload-pack', 401]];

const fail = (message) => { console.error(`release: ${message}`); process.exit(1); };
const token = process.env.CLOUDFLARE_API_TOKEN, account = process.env.CLOUDFLARE_ACCOUNT_ID;
if (!token || !account) fail('run it as `make release`, which supplies the deploy token');
const withoutToken = { ...process.env };
delete withoutToken.CLOUDFLARE_API_TOKEN;

let dir = null;
function run(cmd, args, { log, env = process.env, failure } = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', env, maxBuffer: 256 * 1024 * 1024 });
  const out = (r.stdout ?? '') + (r.stderr ?? '');
  if (log) writeFileSync(join(dir, log), out);
  if (r.status !== 0) fail(`${failure ?? `\`${cmd} ${args.join(' ')}\` failed`}${log ? `; see ${join(dir, log)}` : ''}`);
  return out;
}
const git = (...args) => run('git', args, { env: withoutToken }).trim();

if (git('branch', '--show-current') !== 'main') fail('release from main');
if (git('status', '--porcelain')) fail('the checkout has uncommitted changes');
git('fetch', '-q', 'origin');
const commit = git('rev-parse', 'HEAD'), short = commit.slice(0, 12);
if (commit !== git('rev-parse', 'origin/main')) fail('HEAD is not origin/main: push or pull first');
dir = join(process.env.RELEASE_DIR ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local/state'), 'pimwell/releases'), short);
// One attempt per commit: a second run could double-deploy after an unclear outcome.
if (existsSync(join(dir, 'record.json'))) fail(`${short} was already released or attempted; read ${join(dir, 'record.json')} instead of retrying`);
mkdirSync(dir, { recursive: true, mode: 0o700 });

const recordDeploy = await deployRecorder('pimwell').catch(() => fail('Pimwell deploy reporting preflight failed; nothing was deployed'));
console.log(`Releasing ${short}: install, typecheck, full test suite (a few minutes)…`);
run('npm', ['ci', '--ignore-scripts'], { log: 'install.log', env: withoutToken });
run('npm', ['run', 'typecheck'], { log: 'types.log', env: withoutToken, failure: 'typecheck failed; nothing was released' });
const tests = run('npx', ['vitest', 'run', '--testTimeout=30000'], { log: 'tests.log', env: withoutToken, failure: 'tests failed; nothing was released' });
if (!/Tests\s+\d+ passed/.test(tests)) fail(`no passing test summary; nothing was released; see ${join(dir, 'tests.log')}`);
git('fetch', '-q', 'origin');
if (git('rev-parse', 'origin/main') !== commit) fail('main moved during the tests; nothing was released. Release the new main.');
if (git('status', '--porcelain')) fail('the tests changed the checkout; nothing was released');

async function api(worker, path) {
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/${worker}${path}`, { headers: { authorization: `Bearer ${token}` } });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j?.success) fail(`Cloudflare refused ${worker}${path} (HTTP ${r.status})`);
  return j.result;
}

// Check and upload every Worker before deploying any, so a refusal leaves production untouched.
const bindings = (v) => JSON.stringify([...v.resources.bindings].sort((a, b) => a.name.localeCompare(b.name)));
const targets = [];
for (const { name, config } of WORKERS) {
  const before = (await api(name, '/deployments')).deployments[0];
  if (before.versions.length !== 1 || before.versions[0].percentage !== 100) fail(`${name} is not one version at 100%; settle that first. Nothing was released.`);
  const rollback = before.versions[0].version_id, old = await api(name, `/versions/${rollback}`);
  console.log(`Uploading a new version of ${name}…`);
  const upload = run('npx', ['wrangler', 'versions', 'upload', '-c', config, '--keep-vars', '--tag', commit, '--message', `release ${short}`], { log: `upload-${name}.log`, failure: 'upload failed; nothing was deployed' });
  const version = /Worker Version ID:\s*([0-9a-f-]{36})/.exec(upload)?.[1];
  if (!version) fail(`${name} upload outcome unknown; nothing was deployed; see ${join(dir, `upload-${name}.log`)}`);
  const fresh = await api(name, `/versions/${version}`);
  if (bindings(old) !== bindings(fresh)) fail(`${name} bindings changed: version ${version} is uploaded but nothing was deployed; deploy by hand after review`);
  if (JSON.stringify(old.resources.script_runtime) !== JSON.stringify(fresh.resources.script_runtime)) fail(`${name} runtime or migrations changed: version ${version} is uploaded but nothing was deployed; deploy by hand after review`);
  targets.push({ worker: name, version, rollback_version: rollback, before_deployment: before.id, deployment: null });
}
for (const t of targets) if ((await api(t.worker, '/deployments')).deployments[0].id !== t.before_deployment) fail(`${t.worker} changed during the release; versions are uploaded but nothing was deployed`);

const record = { commit, phase: 'prepared', at: new Date().toISOString(), workers: targets };
const save = () => { writeFileSync(join(dir, 'record.tmp'), JSON.stringify(record, null, 2) + '\n'); renameSync(join(dir, 'record.tmp'), join(dir, 'record.json')); };
const rollbacks = () => targets.map((t) => `make rollback WORKER=${t.worker} VERSION=${t.rollback_version}`).join(' and ');
save();
for (const t of targets) {
  console.log(`Deploying ${t.worker} ${t.version}…`);
  run('npx', ['wrangler', 'versions', 'deploy', '-c', WORKERS.find(w => w.name === t.worker).config, '--name', t.worker, `${t.version}@100%`, '--yes'], { log: `deploy-${t.worker}.log`, failure: `deploying ${t.worker} failed; check production before anything else (${rollbacks()})` });
  for (let i = 0; i < 6 && !t.deployment; i++) {
    const d = (await api(t.worker, '/deployments')).deployments[0];
    if (d.versions.length === 1 && d.versions[0].version_id === t.version && d.versions[0].percentage === 100) { t.deployment = d.id; t.deployed_at = Date.parse(d.created_on); }
    else await new Promise((r) => setTimeout(r, 2000));
  }
  if (!t.deployment) fail(`${t.worker} live outcome unclear; check the dashboard before anything else. Record: ${join(dir, 'record.json')}`);
  save();
  try { t.deploy_record = (await recordDeploy(t, commit)).deploy.id; save(); }
  catch { record.phase = 'report_failed'; save(); fail(`Pimwell deploy recording failed for ${t.worker}; deployment is live. Inspect ${join(dir, 'record.json')}; do not redeploy.`); }
}
record.phase = 'deployed'; save();

record.smoke = {};
for (const [url, want] of SMOKE) {
  const got = (await fetch(url, { redirect: 'manual' }).catch(() => ({ status: 0 }))).status;
  record.smoke[url] = got;
  if (got !== want) { record.phase = 'smoke_failed'; save(); fail(`smoke check ${url} answered ${got}, expected ${want}. Roll back with: ${rollbacks()}`); }
}
record.phase = 'verified'; save();
console.log(JSON.stringify({ phase: 'verified', commit, workers: targets.map(({ worker, version, rollback_version }) => ({ worker, version, rollback_version })), record: join(dir, 'record.json') }));
