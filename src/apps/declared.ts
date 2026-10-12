// Which Worker names a repository declares, from its wrangler configs (wrangler.toml, wrangler.json, wrangler.jsonc, at any
// depth). A project whose own main branch declares a Worker has shown it ships that Worker, so app.register can approve it
// without a root (pimwell#152). Only the top-level name and per-environment names count, never binding or service names.
import type { SnapshotFile } from "../code/gitPack";

const CONFIG_RE = /(^|\/)wrangler(\.[a-z0-9-]+)?\.(toml|json|jsonc)$/;

/** JSONC without comments or trailing commas, leaving strings (and the "//" in URLs) alone. */
export function stripJsonc(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2);
      if (i < 0) break;
      i++;
    } else out += c;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

function jsonNames(text: string): string[] {
  let config: { name?: unknown; env?: Record<string, { name?: unknown }> };
  try { config = JSON.parse(stripJsonc(text)); } catch { return []; }
  if (!config || typeof config !== "object") return [];
  const names = [config.name, ...Object.values(config.env && typeof config.env === "object" ? config.env : {}).map((e) => e?.name)];
  return names.filter((n): n is string => typeof n === "string");
}

function tomlNames(text: string): string[] {
  const names: string[] = [];
  let section = "";
  for (const raw of text.split("\n")) {
    const line = raw.replace(/#.*$/, "").trim();
    const header = /^\[\[?\s*([^\]]+?)\s*\]\]?$/.exec(line);
    if (header) { section = line.startsWith("[[") ? "array" : header[1]!; continue; }
    const name = /^name\s*=\s*["']([^"']+)["']$/.exec(line);
    if (name && (section === "" || /^env\.[A-Za-z0-9_-]+$/.test(section))) names.push(name[1]!);
  }
  return names;
}

/** The config file that declares this Worker, or null. */
export function declaringConfig(files: SnapshotFile[], script: string): string | null {
  for (const f of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    if (!CONFIG_RE.test(f.path) || f.binary || f.text === null) continue;
    const names = f.path.endsWith(".toml") ? tomlNames(f.text) : jsonNames(f.text);
    if (names.some((n) => n.toLowerCase() === script)) return f.path;
  }
  return null;
}
