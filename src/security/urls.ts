/** External evidence links are absolute HTTPS only. HTML escaping does not make a URL safe. */
export function safeExternalUrl(value: string): string | null {
  // Reject URL-parser trimming/control normalization and ambiguous authority separators.
  if (!/^https:\/\//i.test(value) || /^https:\/\/[^/?#]*@/i.test(value) || /[\s\u0000-\u001f\u007f-\u009f\\]/u.test(value) || /%(?:0[0-9a-f]|1[0-9a-f]|7f)/i.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !url.hostname || url.username || url.password) return null;
    return url.href;
  } catch { return null; }
}
