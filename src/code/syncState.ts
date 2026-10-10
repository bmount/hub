// The existing TEXT cursor stores a versioned checkpoint; Ardi only receives `after`.
export type GitSyncState = {
  version: 1;
  after: number;
  cutoff: number | null;
  phase: "backfill" | "live";
  head: number;
  head_at: number | null;
  imported_at: number | null;
  observed_at: number | null;
  caught_up_at: number | null;
};

export function readGitSyncState(cursor: string | null): GitSyncState | null {
  if (!cursor) return null;
  try {
    const s = JSON.parse(cursor) as GitSyncState;
    const id = (v: unknown) => Number.isSafeInteger(v) && Number(v) >= 0;
    const time = (v: unknown) => v === null || id(v);
    if (s?.version !== 1 || !id(s.after) || !id(s.head) || !(s.cutoff === null || id(s.cutoff)) ||
      !["backfill", "live"].includes(s.phase) || ![s.head_at, s.imported_at, s.observed_at, s.caught_up_at].every(time)) return null;
    return s;
  } catch { return null; }
}

export function gitSyncCoverage(row: { cursor: string | null; last_run_at: number | null; last_error: string | null } | undefined) {
  const state = readGitSyncState(row?.cursor ?? null);
  return {
    phase: state?.phase ?? "unknown", cursor: state?.after ?? null, initial_cutoff: state?.cutoff ?? null,
    observed_head: state?.head ?? null, observed_at: state?.observed_at ?? null,
    pending_id_span: state && state.observed_at !== null ? Math.max(0, state.head - state.after) : null,
    lag_ms: state && state.observed_at !== null && state.after >= state.head ? 0 :
      state?.head_at != null && state.imported_at !== null ? Math.max(0, state.head_at - state.imported_at) : null,
    caught_up_at: state?.caught_up_at ?? null, last_run_at: row?.last_run_at ?? null, last_error: row?.last_error ?? null,
  };
}
