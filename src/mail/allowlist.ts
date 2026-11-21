import { getIdentityByEmail, normalizeEmail } from "../db/identities";
import { getMembership } from "../db/memberships";

const GLOBAL_MAIL_ADDRESSES = new Set([
  "mcuban@gmail.com",
  "ryanlkline@gmail.com",
  "mark@costplusdrugs.com",
  "ryan.kline@costplusdrugs.com",
]);

export function isGloballyAllowlisted(address: string): boolean {
  return GLOBAL_MAIL_ADDRESSES.has(normalizeEmail(address));
}

// Disabled attribution record, never an account or membership for the sender.
export const EXTERNAL_MAIL_ID = "allowlisted-external-mail";

export async function inboundSenderId(db: D1Database, from: string, tenantId: string): Promise<string | null> {
  const identity = await getIdentityByEmail(db, from);
  if (identity?.kind === "human" && identity.state === "active"
    && (identity.is_root === 1 || (await getMembership(db, identity.id, tenantId))?.state === "active")) return identity.id;
  return isGloballyAllowlisted(from) ? EXTERNAL_MAIL_ID : null;
}
