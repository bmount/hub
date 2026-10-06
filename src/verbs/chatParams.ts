import { badRequest } from "../errors";
import { optInt, reqString } from "./params";
import { LIMITS } from "../chat/rules";

type Input = Record<string, unknown>;

export const channelParam = (i: Input): string => reqString(i, "c", { max: 64 });
export const afterParam = (i: Input): number | null => optInt(i, "after", { min: 0, max: Number.MAX_SAFE_INTEGER });
export const budgetParam = (i: Input): number => optInt(i, "budget", { min: 100, max: LIMITS.BUDGET_MAX }) ?? LIMITS.BUDGET_DEFAULT;

/** Spec 12: at most 8 KiB, and not blank. */
export function bodyParam(i: Input): string {
  const body = reqString(i, "body", { max: LIMITS.BODY_MAX });
  if (new TextEncoder().encode(body).length > LIMITS.BODY_MAX) throw badRequest("body is longer than 8 KiB");
  if (body.trim() === "") throw badRequest("body is empty");
  return body;
}

/** A message by number (412, "412", "#412") or by msg_id. */
export function msgParam(i: Input, key: string, required: true): string;
export function msgParam(i: Input, key: string, required: false): string | null;
export function msgParam(i: Input, key: string, required: boolean): string | null {
  const v = i[key];
  if (v === undefined || v === null || v === "") {
    if (required) throw badRequest(`${key} is required`);
    return null;
  }
  if (typeof v === "number" && Number.isSafeInteger(v) && v > 0) return String(v);
  if (typeof v !== "string") throw badRequest(`${key} must be a message number or id`);
  const t = v.trim().replace(/^#/, "");
  if (!/^\d{1,12}$/.test(t) && !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(t)) throw badRequest(`${key} must be a message number or id`);
  return t;
}

/** Spec 5.1: explicit refs, `[{kind, key}]`, key in body syntax. */
export function refsParam(i: Input): Array<{ kind: string; key: string }> {
  const v = i.refs;
  if (v === undefined || v === null || v === "") return [];
  if (!Array.isArray(v) || v.length > LIMITS.REFS_MAX) throw badRequest(`refs must be a list of at most ${LIMITS.REFS_MAX} {kind, key}`);
  return v.map((x) => {
    const r = (x ?? {}) as { kind?: unknown; key?: unknown };
    if (typeof r.kind !== "string" || typeof r.key !== "string" || r.kind.length > 16 || r.key.length > 128) throw badRequest("each ref is {kind, key}");
    return { kind: r.kind, key: r.key };
  });
}
