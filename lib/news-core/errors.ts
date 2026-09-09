import "server-only";

export type SagaNewsErrorCode =
  | "configuration"
  | "outbound_url"
  | "outbound_dns"
  | "outbound_response"
  | "rate_limited"
  | "provider_response"
  | "provider_unavailable";

/** Public-safe error: never include a configured URL, API key or response body. */
export class SagaNewsCoreError extends Error {
  constructor(
    readonly code: SagaNewsErrorCode,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "SagaNewsCoreError";
  }
}
