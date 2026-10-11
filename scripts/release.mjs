#!/usr/bin/env node
// `make release`: put the current main into production. Pushing never deploys; releasing is this separate step, for
// whoever holds the deploy token (scripts/cf/with-deploy-token.sh supplies it). It tests the exact commit, uploads a
// version that keeps the dashboard's vars, refuses binding or runtime changes, records the rollback version, deploys
// and smoke-checks. Logs and a record go to $RELEASE_DIR/<commit>/ (default ~/.local/state/pimwell/releases).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const WORKER = 'pimwell-hub';
const SMOKE = [['https://pimwell.com/', 200], ['https://pimwell.com/login', 200], ['https://pimwell.com/healthz', 200],
  ['https://mcc.pimwell.com/setup', 200], ['https://mcc.pimwell.com/.well-known/oauth-protected-resource/mcp', 200],
  ['https://mcc.pimwell.com/mail', 404], ['https://mcc.pimwell.com/agent/mcp', 401]];

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

console.log(`Releasing ${short}: install, typecheck, full test suite (a few minutes)…`);
run('npm', ['ci', '--ignore-scripts'], { log: 'install.log', env: withoutToken });
run('npm', ['run', 'typecheck'], { log: 'types.log', env: withoutToken, failure: 'typecheck failed; nothing was released' });
const tests = run('npx', ['vitest', 'run', '--testTimeout=30000'], { log: 'tests.log', env: withoutToken, failure: 'tests failed; nothing was released' });
if (!/Tests\s+\d+ passed/.test(tests)) fail(`no passing test summary; nothing was released; see ${join(dir, 'tests.log')}`);
git('fetch', '-q', 'origin');
if (git('rev-parse', 'origin/main') !== commit) fail('main moved during the tests; nothing was released. Release the new main.');
if (git('status', '--porcelain')) fail('the tests changed the checkout; nothing was released');

async function api(path) {
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/${WORKER}${path}`, { headers: { authorization: `Bearer ${token}` } });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j?.success) fail(`Cloudflare refused ${path} (HTTP ${r.status})`);
  return j.result;
}
const before = (await api('/deployments')).deployments[0];
if (before.versions.length !== 1 || before.versions[0].percentage !== 100) fail('production is not one version at 100%; settle that first. Nothing was released.');
const rollback = before.versions[0].version_id, old = await api(`/versions/${rollback}`);

console.log('Uploading a new version…');
const upload = run('npx', ['wrangler', 'versions', 'upload', '--keep-vars', '--tag', short, '--message', `release ${short}`], { log: 'upload.log', failure: 'upload failed; nothing was deployed' });
const version = /Worker Version ID:\s*([0-9a-f-]{36})/.exec(upload)?.[1];
if (!version) fail(`upload outcome unknown; nothing was deployed; see ${join(dir, 'upload.log')}`);
const fresh = await api(`/versions/${version}`);
const bindings = (v) => JSON.stringify([...v.resources.bindings].sort((a, b) => a.name.localeCompare(b.name)));
if (bindings(old) !== bindings(fresh)) fail(`bindings changed: version ${version} is uploaded but not deployed; deploy it by hand after review`);
if (JSON.stringify(old.resources.script_runtime) !== JSON.stringify(fresh.resources.script_runtime)) fail(`runtime or migrations changed: version ${version} is uploaded but not deployed; deploy it by hand after review`);
if ((await api('/deployments')).deployments[0].id !== before.id) fail(`production changed during the release: version ${version} is uploaded but not deployed`);

const record = { worker: WORKER, commit, version, rollback_version: rollback, before_deployment: before.id, phase: 'prepared', at: new Date().toISOString() };
const save = () => { writeFileSync(join(dir, 'record.tmp'), JSON.stringify(record, null, 2) + '\n'); renameSync(join(dir, 'record.tmp'), join(dir, 'record.json')); };
save();
console.log(`Deploying ${version}…`);
run('npx', ['wrangler', 'versions', 'deploy', `${version}@100%`, '--yes'], { log: 'deploy.log', failure: `deploy command failed; check production before anything else (rollback: make rollback VERSION=${rollback})` });
let live = null;
for (let i = 0; i < 6 && !live; i++) {
  const d = (await api('/deployments')).deployments[0];
  if (d.versions.length === 1 && d.versions[0].version_id === version && d.versions[0].percentage === 100) live = d;
  else await new Promise((r) => setTimeout(r, 2000));
}
if (!live) fail(`live outcome unclear; check the dashboard before anything else. Record: ${join(dir, 'record.json')}`);
record.phase = 'deployed'; record.deployment = live.id; save();

record.smoke = {};
for (const [url, want] of SMOKE) {
  const got = (await fetch(url, { redirect: 'manual' }).catch(() => ({ status: 0 }))).status;
  record.smoke[url] = got;
  if (got !== want) { record.phase = 'smoke_failed'; save(); fail(`smoke check ${url} answered ${got}, expected ${want}. Roll back with: make rollback VERSION=${rollback}`); }
}
record.phase = 'verified'; save();
console.log(JSON.stringify({ phase: 'verified', commit, version, deployment: live.id, rollback_version: rollback, record: join(dir, 'record.json') }));
