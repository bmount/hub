import { badRequest, conflict } from "../errors";
import { normalizeEmail } from "./identities";

export function addressInput(value: string): string {
  const email = normalizeEmail(value);
  if (email.length > 254 || !/^[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+$/.test(email)) throw badRequest("invalid email");
  return email;
}

export function listIdentityEmails(db: D1Database, id: string) {
  return db.prepare("SELECT email, confirmed_at FROM identity_email WHERE identity_id = ? ORDER BY email")
    .bind(id).all<{email: string; confirmed_at: number}>();
}

export async function linkIdentityEmail(db: D1Database, id: string, email: string, by: string, now: number): Promise<void> {
  try {
    await db.prepare("INSERT INTO identity_email (email, identity_id, confirmed_at, confirmed_by) VALUES (?, ?, ?, ?)")
      .bind(addressInput(email), id, now, by).run();
  } catch (e) {
    if (/UNIQUE|email exists/.test(String(e))) throw conflict("address already belongs to an identity");
    throw e;
  }
}

// Use inside admission writes too: removing an address must end its authority
// even when the removal races an earlier identity lookup.
export const mailIdentityAddress = (identity = "i", address = "m.from_email") =>
  `(${identity}.email = ${address} OR EXISTS (SELECT 1 FROM identity_email ie WHERE ie.identity_id = ${identity}.id AND ie.email = ${address}))`;
