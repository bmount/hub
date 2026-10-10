import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const OID = /^[0-9a-f]{40}$/;

type SyncInput = { upstream: string; destination: string; branch: string; apply?: boolean };
type RunGit = (cwd: string, args: string[], publicRead: boolean) => string;

function validate(upstream: string, destination: string, branch: string) {
  if ([upstream, destination, branch].some(value => typeof value !== "string" || /[\x00-\x20\x7f]/.test(value))) {
    throw new Error("URLs and branch names must be strings without whitespace or controls.");
  }
  if (!/^https:\/\/github\.com\/[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+\.git$/.test(upstream)) {
    throw new Error("Upstream must be a credential-free https://github.com/owner/repo.git URL.");
  }
  if (!/^https:\/\/[a-z][a-z0-9-]{1,62}\.pimwell\.com\/[a-z][a-z0-9-]{1,62}\.git$/.test(destination)) {
    throw new Error("Destination must be a credential-free https://organization.pimwell.com/repo.git URL.");
  }
  if (typeof branch !== "string" || !/^[A-Za-z0-9_][A-Za-z0-9._/-]{0,199}$/.test(branch)) {
    throw new Error("Give one branch name, not a refspec or revision expression.");
  }
}

function git(cwd: string, args: string[], publicRead: boolean): string {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  if (publicRead) {
    // Isolate public reads from URL rewrites, auth headers, helpers and ~/.netrc.
    Object.assign(env, { HOME: cwd, XDG_CONFIG_HOME: cwd, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_SYSTEM: devNull });
  }
  try {
    return execFileSync("git", ["-c", "http.followRedirects=false", "-c", `core.hooksPath=${devNull}`, ...args], {
      cwd, encoding: "utf8", timeout: 120_000, maxBuffer: 1024 * 1024,
      env: { ...env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", SSH_ASKPASS: "" },
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    // Git and credential helpers can include credentials or remote content in diagnostics.
    throw new Error("Git operation failed; raw diagnostics withheld.");
  }
}

/** One explicit inbound branch update. Git owns transport, object validation and ref concurrency. */
export function syncUpstream({ upstream, destination, branch, apply = false }: SyncInput, runGit: RunGit = git) {
  validate(upstream, destination, branch);
  const directory = mkdtempSync(join(tmpdir(), "pimwell-upstream-"));
  const run = (args: string[], publicRead = false) => runGit(directory, args, publicRead);
  const ref = `refs/heads/${branch}`;
  try {
    run(["check-ref-format", ref]);
    run(["init", "--bare", "--quiet", "--template="]);
    // Public upstream reads must not send credentials from a configured GitHub helper.
    run(["-c", "credential.helper=", "-c", "http.extraHeader=", "-c", `http.${upstream}.extraHeader=`, "fetch", "--quiet", "--no-tags", upstream, `${ref}:refs/heads/upstream`], true);
    run(["fetch", "--quiet", "--no-tags", destination, `${ref}:refs/heads/destination`]);
    const incoming = run(["rev-parse", "refs/heads/upstream"]);
    const current = run(["rev-parse", "refs/heads/destination"]);
    if (!OID.test(incoming) || !OID.test(current)) throw new Error("Expected SHA-1 Git object IDs.");
    if (incoming === current) return { status: "up-to-date", branch, current, incoming };
    try {
      run(["merge-base", "--is-ancestor", current, incoming]);
    } catch {
      throw new Error("Destination is not an ancestor of upstream, or ancestry could not be verified; no push attempted.");
    }
    if (!apply) return { status: "would-fast-forward", branch, current, incoming };
    try {
      // No force: a concurrent diverging destination update must be rejected by the host.
      run(["push", "--porcelain", destination, `${incoming}:${ref}`]);
      const observed = run(["ls-remote", "--refs", destination, ref]);
      if (observed !== `${incoming}\t${ref}`) throw new Error("Unverified update");
    } catch {
      throw new Error("Push refused or outcome unverified; reconcile with a dry run before applying again.");
    }
    return { status: "fast-forwarded", branch, current, incoming };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length !== 3 && !(args.length === 4 && args[3] === "--apply")) {
    console.error("Usage: node scripts/sync-upstream.ts <GitHub URL> <Pimwell URL> <branch> [--apply]");
    process.exitCode = 1;
  } else {
    try {
      console.log(JSON.stringify(syncUpstream({ upstream: args[0]!, destination: args[1]!, branch: args[2]!, apply: args.length === 4 })));
    } catch (error) {
      console.error(error instanceof Error ? error.message : "Sync failed.");
      process.exitCode = 1;
    }
  }
}
