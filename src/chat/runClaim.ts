export type RunSource = { msg_id: string; rev: number; author_id: string };

/** A reservation is not proof a model started, a live lease, or delegated execution authority. */
export type RunClaim = { source: RunSource; claimed_at: number; authority: "conversation_only" };
export type RunStatus = {
  source: RunSource & { retracted: boolean };
  claim: RunClaim | null;
  source_matches: boolean | null;
};
export type RunClaimOutcome = (RunStatus & { acquired: boolean }) | { refused: "not_found" | "conflict" | "forbidden"; detail: string };
