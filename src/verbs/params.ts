import { badRequest } from "../errors";

type Input = Record<string, unknown>;

export function reqString(input: Input, key: string, opts: { max?: number } = {}): string {
  const v = input[key];
  if (typeof v !== "string" || v.length === 0) throw badRequest(`${key} is required`);
  if (opts.max !== undefined && v.length > opts.max) throw badRequest(`${key} is too long`);
  return v;
}

export function optString(input: Input, key: string, opts: { max?: number } = {}): string | null {
  const v = input[key];
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string") throw badRequest(`${key} must be a string`);
  if (opts.max !== undefined && v.length > opts.max) throw badRequest(`${key} is too long`);
  return v;
}

export function reqEnum<T extends string>(input: Input, key: string, values: readonly T[]): T {
  const v = input[key];
  if (typeof v !== "string" || !(values as readonly string[]).includes(v)) throw badRequest(`${key} must be one of ${values.join(", ")}`);
  return v as T;
}

export function optBool(input: Input, key: string): boolean | null {
  const v = input[key];
  if (v === undefined || v === null || v === "") return null;
  if (v === true || v === "true" || v === "1" || v === "on") return true;
  if (v === false || v === "false" || v === "0" || v === "off") return false;
  throw badRequest(`${key} must be a boolean`);
}
