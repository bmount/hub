import { ulid } from "../ids";
import type { Proof, ProofKind } from "./types";

export async function recordProof(db: D1Database, input: { identity_id: string; kind: ProofKind; subject: string }, now: number): Promise<Proof> {
  const row: Proof = { id: ulid(now), identity_id: input.identity_id, kind: input.kind, subject: input.subject, created_at: now };
  await db.prepare("INSERT INTO proof (id, identity_id, kind, subject, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(row.id, row.identity_id, row.kind, row.subject, row.created_at).run();
  return row;
}

export async function listProofs(db: D1Database, identity_id: string): Promise<Proof[]> {
  const r = await db.prepare("SELECT * FROM proof WHERE identity_id = ? ORDER BY created_at, id").bind(identity_id).all<Proof>();
  return r.results;
}
