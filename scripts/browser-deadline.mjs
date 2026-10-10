// Use Node's real clock: Playwright's page clock may be paused/advanced by a fixture.
// Playwright Response.finished() has no timeout, even with setDefaultTimeout().
export async function withBrowserDeadline(operation, stage, timeoutMs = 15_000) {
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Browser acceptance deadline: ${stage}`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function finishedResponse(response, stage, timeoutMs = 15_000) {
  const failure = await withBrowserDeadline(response.finished(), stage, timeoutMs);
  if (failure) throw new Error(`Browser acceptance response failed: ${stage}`);
}
