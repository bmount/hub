import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});
import { syncUpstream } from "../../scripts/sync-upstream";

const upstream = "https://github.com/example/source.git";
const destination = "https://acme.pimwell.com/imported.git";
const directories: string[] = [];
afterEach(() => { vi.mocked(execFileSync).mockRestore(); for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });

function world() {
  const root = mkdtempSync(join(tmpdir(), "pimwell-sync-test-"));
  directories.push(root);
  const source = join(root, "source.git"), target = join(root, "target.git"), work = join(root, "work");
  const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git(root, ["init", "--bare", source]);
  git(root, ["init", "--bare", target]);
  git(root, ["init", "--initial-branch=main", work]);
  git(work, ["config", "user.email", "test@example.test"]);
  git(work, ["config", "user.name", "Test"]);
  const commit = () => { git(work, ["commit", "--allow-empty", "-m", "Commit"]); return git(work, ["rev-parse", "HEAD"]); };
  const initial = commit();
  git(work, ["push", source, "HEAD:refs/heads/main"]);
  git(work, ["push", target, "HEAD:refs/heads/main"]);
  const seen: string[][] = [], scratch: string[] = [];
  const run = (cwd: string, args: string[]) => {
    scratch.push(cwd); seen.push(args);
    return git(cwd, args.map(arg => arg === upstream ? source : arg === destination ? target : arg));
  };
  const read = () => git(target, ["rev-parse", "refs/heads/main"]);
  const sync = (apply = false, runner = run) => syncUpstream({ upstream, destination, branch: "main", apply }, runner);
  return { root, source, target, work, git, initial, commit, seen, scratch, run, read, sync };
}

describe("manual upstream branch synchronization", () => {
  it("isolates public Git reads and withholds credential-bearing subprocess failures", () => {
    const mock = vi.mocked(execFileSync);
    mock.mockImplementation((_command, args, options) => {
      if ((args as string[]).includes("fetch")) throw new Error("stderr contains private-password");
      return "";
    });
    expect(() => syncUpstream({ upstream, destination, branch: "main", apply: true })).toThrow("raw diagnostics withheld");
    const calls = mock.mock.calls;
    expect(calls).toHaveLength(3);
    const args = calls[2]![1] as string[], options = calls[2]![2] as { cwd: string; env: Record<string, string>; timeout: number; stdio: string[] };
    expect(args).toContain("http.followRedirects=false");
    expect(args).toContain("credential.helper=");
    expect(calls[1]![1]).toContain("--template=");
    expect(options.env).toMatchObject({ HOME: options.cwd, XDG_CONFIG_HOME: options.cwd, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "" });
    expect(options.env.GIT_CONFIG_GLOBAL).toBe(options.env.GIT_CONFIG_SYSTEM);
    expect(options.env.GIT_DIR).toBeUndefined();
    expect(options.env.GIT_WORK_TREE).toBeUndefined();
    expect(options.timeout).toBe(120_000);
    expect(options.stdio).toEqual(["ignore", "pipe", "pipe"]);
    expect(existsSync(options.cwd)).toBe(false);
  });

  it("defaults to dry run, applies a fast-forward and reconciles repeat calls without another push", () => {
    const w = world();
    const incoming = w.commit();
    w.git(w.work, ["push", w.source, "HEAD:refs/heads/main"]);
    expect(w.sync()).toEqual({ status: "would-fast-forward", branch: "main", current: w.initial, incoming });
    expect(w.read()).toBe(w.initial);
    expect(w.seen.some(args => args[0] === "push")).toBe(false);
    expect(w.sync(true)).toEqual({ status: "fast-forwarded", branch: "main", current: w.initial, incoming });
    expect(w.read()).toBe(incoming);
    expect(w.sync(true)).toMatchObject({ status: "up-to-date", current: incoming });
    expect(w.seen.filter(args => args[0] === "push")).toEqual([["push", "--porcelain", destination, `${incoming}:refs/heads/main`]]);
    expect(w.seen).toContainEqual(["-c", "credential.helper=", "-c", "http.extraHeader=", "-c", `http.${upstream}.extraHeader=`, "fetch", "--quiet", "--no-tags", upstream, "refs/heads/main:refs/heads/upstream"]);
    expect(w.scratch.every(path => !existsSync(path))).toBe(true);
  });

  it.each(["diverged", "rewound"])("refuses %s upstream history before any push", (kind) => {
    const w = world();
    const hosted = w.commit();
    w.git(w.work, ["push", w.target, "HEAD:refs/heads/main"]);
    if (kind === "diverged") {
      w.git(w.work, ["checkout", "--detach", w.initial]);
      w.git(w.work, ["commit", "--allow-empty", "-m", "Different upstream"]);
      w.git(w.work, ["push", w.source, "HEAD:refs/heads/main"]);
    }
    expect(() => w.sync(true)).toThrow("no push attempted");
    expect(w.read()).toBe(hosted);
    expect(w.seen.some(args => args[0] === "push")).toBe(false);
    expect(w.scratch.every(path => !existsSync(path))).toBe(true);
  });

  it("refuses a concurrent diverging update rather than forcing it", () => {
    const w = world();
    const incoming = w.commit();
    w.git(w.work, ["push", w.source, "HEAD:refs/heads/main"]);
    w.git(w.work, ["checkout", "--detach", w.initial]);
    w.git(w.work, ["commit", "--allow-empty", "-m", "Concurrent change"]);
    const concurrent = w.git(w.work, ["rev-parse", "HEAD"]);
    expect(() => w.sync(true, (cwd, args) => {
      if (args[0] === "push") w.git(w.work, ["push", w.target, "HEAD:refs/heads/main"]);
      return w.run(cwd, args);
    })).toThrow("reconcile with a dry run");
    expect(w.read()).toBe(concurrent);
    expect(w.read()).not.toBe(incoming);
  });

  it("does not report success when post-push verification fails, and reconciles the actual update", () => {
    const w = world();
    const incoming = w.commit();
    w.git(w.work, ["push", w.source, "HEAD:refs/heads/main"]);
    expect(() => w.sync(true, (cwd, args) => args[0] === "ls-remote" ? `${w.initial}\trefs/heads/main` : w.run(cwd, args))).toThrow("outcome unverified");
    expect(w.read()).toBe(incoming);
    expect(w.sync(true)).toMatchObject({ status: "up-to-date" });
    expect(w.seen.filter(args => args[0] === "push")).toHaveLength(1);
  });

  it("keeps unrelated branches and tags, and supports a slash-containing branch", () => {
    const w = world();
    w.git(w.work, ["push", w.target, "HEAD:refs/heads/local", "HEAD:refs/tags/keep"]);
    w.git(w.work, ["push", w.source, "HEAD:refs/heads/topic/sub"]);
    w.git(w.work, ["push", w.target, "HEAD:refs/heads/topic/sub"]);
    const incoming = w.commit();
    w.git(w.work, ["push", w.source, "HEAD:refs/heads/topic/sub"]);
    expect(syncUpstream({ upstream, destination, branch: "topic/sub", apply: true }, w.run)).toMatchObject({ status: "fast-forwarded", incoming });
    expect(w.read()).toBe(w.initial);
    expect(w.git(w.target, ["rev-parse", "refs/heads/local"])).toBe(w.initial);
    expect(w.git(w.target, ["rev-parse", "refs/tags/keep"])).toBe(w.initial);
  });

  it("requires an existing hosted branch and stops on fetch or object-ID failures", () => {
    const w = world();
    w.git(w.target, ["update-ref", "-d", "refs/heads/main"]);
    expect(() => w.sync(true)).toThrow();
    expect(w.seen.some(args => args[0] === "push")).toBe(false);
    expect(w.scratch.every(path => !existsSync(path))).toBe(true);
    expect(() => w.sync(true, (_cwd, args) => args[0] === "rev-parse" ? "not-an-oid" : "")).toThrow("Expected SHA-1");
  });

  it.each([
    ["https://user:password@github.com/a/b.git", destination, "main"],
    ["https://github.com/a/b.git?token=secret", destination, "main"],
    ["https://evil.test/a/b.git", destination, "main"],
    ["http://github.com/a/b.git", destination, "main"],
    [upstream, "https://acme.pimwell.com/other/repo.git", "main"],
    [upstream, "https://acme.pimwell.com/repo.git#secret", "main"],
    [upstream, "https://user:secret@acme.pimwell.com/repo.git", "main"],
    [upstream, "https://acme.pimwell.com.evil.test/repo.git", "main"],
    [upstream, destination, "+main:other"], [upstream, destination, "--all"],
    [upstream, destination, "main\n"], [upstream, destination, "main~1"],
  ])("rejects unsafe input without executing Git", (source, target, branch) => {
    const seen: string[][] = [];
    expect(() => syncUpstream({ upstream: source, destination: target, branch, apply: true }, (_cwd: string, args: string[]) => { seen.push(args); return ""; })).toThrow();
    expect(seen).toEqual([]);
  });

  it.each(["main..other", "topic//sub", "topic/.hidden", "topic.lock"])("checks Git ref syntax before transfer: %s", (branch) => {
    const w = world();
    expect(() => syncUpstream({ upstream, destination, branch, apply: true }, w.run)).toThrow();
    expect(w.seen).toEqual([["check-ref-format", `refs/heads/${branch}`]]);
  });
});
