const MAP: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => MAP[ch]!);
}

export function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
body{font:16px/1.5 system-ui,sans-serif;max-width:48rem;margin:2rem auto;padding:0 1rem;color:#111;background:#fff}
h1{font-size:1.5rem}table{border-collapse:collapse}td,th{padding:.25rem .75rem .25rem 0;text-align:left}
form.inline{display:inline}button{font:inherit}
</style>
</head>
<body>
${body}
</body>
</html>
`;
}

export function htmlResponse(body: string, status = 200, headers: HeadersInit = {}): Response {
  const h = new Headers(headers);
  h.set("content-type", "text/html; charset=utf-8");
  h.set("cache-control", "no-store");
  h.set("referrer-policy", "no-referrer");
  h.set("x-content-type-options", "nosniff");
  return new Response(body, { status, headers: h });
}
