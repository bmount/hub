export class HubError extends Error {
  constructor(
    public status: number,
    public reason: string,
    public detail?: string,
  ) {
    super(detail ?? reason);
    this.name = "HubError";
  }
}

export const notFound = (detail?: string) => new HubError(404, "not_found", detail);
export const forbidden = (detail?: string) => new HubError(403, "forbidden", detail);
export const conflict = (detail?: string) => new HubError(409, "conflict", detail);
export const badRequest = (detail?: string) => new HubError(400, "bad_request", detail);
export const unauthorized = (detail?: string) => new HubError(401, "unauthorized", detail);
