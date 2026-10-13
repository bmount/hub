import fs from "node:fs";
import path from "node:path";

export type WranglerConfig = {
  vars?: Record<string, unknown>;
  services?: Array<{ binding?: string; service?: string }>;
  r2_buckets?: Array<{ binding?: string; bucket_name?: string }>;
  [key: string]: unknown;
};

const root = path.resolve(import.meta.dirname, "..");

function stripJsonComments(source: string): string {
  let out = "";
  let inString = false;
  let quote = "";
  let escaped = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]!;
    const next = source[i + 1];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === quote) inString = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i++;
      i++;
      continue;
    }
    out += ch;
  }
  return out;
}

export function readWranglerConfig(configPath = path.join(root, "wrangler.jsonc")): WranglerConfig {
  return JSON.parse(stripJsonComments(fs.readFileSync(configPath, "utf8"))) as WranglerConfig;
}

export function buildLocalTestWranglerConfig(): WranglerConfig {
  const config = readWranglerConfig();
  return {
    ...config,
    vars: { ...config.vars, GIT_BACKEND: "" },
    // Never submit synthetic fixture traffic to the production performance dataset.
    // Collection tests inject their own point writer.
    analytics_engine_datasets: [],
    services: (config.services ?? []).filter((service) => service.binding !== "GIT_PROXY"),
  };
}

export function writeLocalTestWranglerConfig(): string {
  const configPath = path.join(root, ".wrangler-vitest.jsonc");
  fs.writeFileSync(configPath, JSON.stringify(buildLocalTestWranglerConfig(), null, 2));
  return configPath;
}
