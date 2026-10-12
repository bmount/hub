/** Thin REST client. Commands and typed flags come from the server's verb table. */
export function parseArgs(argv, verbs) {
  const args = [...argv];
  const json = args.includes("--json");
  if (json) args.splice(args.indexOf("--json"), 1);
  let name = args.shift();
  if (name && !verbs.some(v => v.name === name)) name += "." + args.shift();
  const verb = verbs.find(v => v.name === name);
  if (!verb) throw new Error("Unknown verb; use --help to list commands");
  const properties = verb.inputSchema?.properties ?? {};
  const input = {};
  while (args.length) {
    const arg = args.shift();
    if (!arg.startsWith("--")) {
      if (!properties.id || input.id !== undefined) throw new Error("Unexpected positional argument");
      input.id = arg;
      continue;
    }
    const key = arg.slice(2).replaceAll("-", "_");
    if (key === "input") {
      const value = JSON.parse(args.shift());
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("--input needs a JSON object");
      Object.assign(input, value);
      continue;
    }
    if (verb.inputSchema?.additionalProperties === false && !Object.hasOwn(properties, key)) throw new Error("Unknown flag: " + arg);
    const schema = properties[key] ?? {};
    const type = schema.type;
    let value = args[0];
    if (type === "boolean" && (value === undefined || value.startsWith("--"))) value = true;
    else {
      if (value === undefined || value.startsWith("--")) throw new Error("Missing value: " + arg);
      args.shift();
      if (type === "boolean") {
        if (!["true", "false"].includes(value)) throw new Error("Expected true or false: " + arg);
        value = value === "true";
      } else if (type === "number" || type === "integer") {
        value = Number(value);
        if (!Number.isFinite(value) || (type === "integer" && !Number.isInteger(value))) throw new Error("Expected " + type + ": " + arg);
      } else if (type === "array" || type === "object" || (!type && (value.startsWith("[") || value.startsWith("{")))) value = JSON.parse(value);
    }
    input[key] = value;
  }
  return { name, input, json };
}

export async function runCli(argv, { url, token, fetch: request = globalThis.fetch, write = console.log }) {
  const base = new URL(url);
  if (base.username || base.password || base.search || base.hash || base.pathname !== "/" ||
      (base.protocol !== "https:" && !(base.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname))))
    throw new Error("PIMWELL_URL must be an HTTPS origin (HTTP allowed only on loopback)");
  const call = async (path, input, credential) => {
    const response = await request(new URL(path, base), {
      method: input === undefined ? "GET" : "POST", redirect: "manual",
      headers: { "content-type": "application/json", ...(credential ? { authorization: "Bearer " + credential } : {}) },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    });
    if (response.status >= 300 && response.status < 400) throw new Error("API redirect refused");
    const body = await response.json();
    if (!response.ok || !body.ok) throw new Error(body.error + (body.detail ? ": " + body.detail : ""));
    return body.result;
  };
  const { verbs } = await call("/api/schema");
  if (!argv.length || argv.includes("--help")) {
    write(verbs.map(v => v.name.replace(".", " ") + " — " + v.summary +
      "\n  " + Object.keys(v.inputSchema?.properties ?? {}).map(k => "--" + k.replaceAll("_", "-")).join(" ")).join("\n"));
    return;
  }
  const command = parseArgs(argv, verbs);
  if (!token) throw new Error("Set PIMWELL_TOKEN_FILE, PIMWELL_TOKEN, or configure a git credential helper");
  if (token.startsWith("pmw_") && !["session.start", "whoami"].includes(command.name)) {
    token = (await call("/api/session.start", { label: "cli", ttl: 3600 }, token)).session_token;
  }
  const result = await call("/api/" + command.name, command.input, token);
  write(command.json ? JSON.stringify(result) : human(result));
  return result;
}

function human(value, indent = "") {
  if (value === null || typeof value !== "object") return String(value);
  return Object.entries(value).map(([key, item]) =>
    indent + key + ": " + (item !== null && typeof item === "object" ? "\n" + human(item, indent + "  ") : String(item))).join("\n");
}
