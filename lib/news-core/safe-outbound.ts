import "server-only";

import { lookup as nodeLookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { SagaNewsCoreError } from "@/lib/news-core/errors";
import { awaitAbortableRead, executionAbortSignal, withExecutionReserve } from "@/lib/server/execution-deadline";

export const SAGA_NEWS_MAX_RESPONSE_BYTES = 1_000_000;
export const SAGA_NEWS_FETCH_TIMEOUT_MS = 15_000;

export type SagaNewsOutboundPolicy = Readonly<{
  allowedHosts: readonly string[];
  /** Only provider-owned connectors may opt in; generic RSS URLs never can. */
  allowQuery?: boolean;
  acceptedContentTypes: readonly string[];
  maxBytes?: number;
  timeoutMs?: number;
}>;

export type SagaNewsOutboundRequest = Readonly<{
  url: URL;
  policy: SagaNewsOutboundPolicy;
}>;

export type SagaNewsTextResponse = Readonly<{
  status: number;
  contentType: string;
  text: string;
}>;

export type SagaNewsTextFetcher = (request: SagaNewsOutboundRequest) => Promise<SagaNewsTextResponse>;

type ResolvedHost = Readonly<{
  address: string;
  family: 4 | 6;
}>;

type Lookup = (hostname: string, options: { all: true; verbatim: true }) => Promise<Array<{ address: string; family: number }>>;

const LOCAL_HOSTS = new Set(["localhost", "localhost.localdomain", "ip6-localhost", "ip6-loopback"]);

/**
 * Validates the source address before a network connection is opened. It is
 * exported for configuration tests, but must only be called server-side.
 */
export function validateSagaNewsOutboundUrl(urlValue: URL, policy: SagaNewsOutboundPolicy): URL {
  const url = new URL(urlValue.toString());
  const hostname = url.hostname.toLowerCase().replace(/\.$/u, "");
  const allowedHosts = normalizedAllowedHosts(policy.allowedHosts);
  if (url.protocol !== "https:" || !hostname || url.username || url.password || url.port) {
    throw new SagaNewsCoreError("outbound_url", "Källans endpoint måste vara HTTPS utan inloggningsuppgifter eller egen port.", 422);
  }
  if (isIP(hostname) || LOCAL_HOSTS.has(hostname) || hostname.endsWith(".localhost")) {
    throw new SagaNewsCoreError("outbound_url", "Källans endpoint får inte vara en IP-adress, lokal värd eller privat server.", 422);
  }
  if (!allowedHosts.some((allowed) => hostname === allowed || hostname.endsWith(`.${allowed}`))) {
    throw new SagaNewsCoreError("outbound_url", "Källans endpoint finns inte i den godkända värdlistan.", 422);
  }
  if (!policy.allowQuery && url.search) {
    throw new SagaNewsCoreError("outbound_url", "Publika RSS- och Atom-adresser får inte innehålla query-parametrar.", 422);
  }
  if (url.hash) {
    throw new SagaNewsCoreError("outbound_url", "Källans endpoint får inte innehålla ett ankare.", 422);
  }
  url.hostname = hostname;
  return url;
}

/**
 * Fetches one HTTPS document through a DNS-pinned socket. Redirects are
 * intentionally refused: callers must configure the final public HTTPS URL.
 * The function never serializes or logs its URL, which keeps provider API
 * keys out of application diagnostics.
 */
export const fetchSagaNewsText: SagaNewsTextFetcher = async (request) => withExecutionReserve(2_000, async () => {
  const url = validateSagaNewsOutboundUrl(request.url, request.policy);
  const resolvedHost = await resolvePublicHost(url.hostname);
  return pinnedHttpsTextRequest(url, resolvedHost, request.policy);
});

export async function resolveSagaNewsPublicHost(hostnameValue: string, dnsLookup: Lookup = nodeLookup): Promise<ResolvedHost> {
  const hostname = hostnameValue.toLowerCase().replace(/^\[|\]$/gu, "").replace(/\.$/u, "");
  if (!hostname || isIP(hostname) || LOCAL_HOSTS.has(hostname) || hostname.endsWith(".localhost")) {
    throw new SagaNewsCoreError("outbound_dns", "Källans värdnamn får inte vara lokalt eller en direkt IP-adress.", 422);
  }
  let answers: ResolvedHost[];
  try {
    answers = (await awaitAbortableRead(dnsLookup(hostname, { all: true, verbatim: true }))).flatMap((entry) => {
      if (entry.family !== 4 && entry.family !== 6) return [];
      return [{ address: entry.address, family: entry.family }];
    });
  } catch {
    throw new SagaNewsCoreError("outbound_dns", "Källans värdnamn kunde inte verifieras.", 422);
  }
  if (!answers.length || answers.some((entry) => isUnsafeSagaNewsAddress(entry.address))) {
    throw new SagaNewsCoreError("outbound_dns", "Källans värdnamn pekar mot en privat, loopback- eller link-local-adress.", 422);
  }
  return answers[0];
}

/** Boundary helper for tests and any future source-admin validation flow. */
export function isUnsafeSagaNewsAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && (b === 0 || b === 168))
      || (a === 198 && (b === 18 || b === 19));
  }
  const groups = ipv6Groups(address);
  if (!groups) return true;
  const allZero = groups.every((part) => part === 0);
  if (allZero || (groups.slice(0, 7).every((part) => part === 0) && groups[7] === 1)) return true;
  if ((groups[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((groups[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link local
  if ((groups[0] & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  const v4Compatible = groups.slice(0, 6).every((part) => part === 0);
  const v4Mapped = groups.slice(0, 5).every((part) => part === 0) && groups[5] === 0xffff;
  if (v4Compatible || v4Mapped) {
    const dotted = [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff].join(".");
    return isUnsafeSagaNewsAddress(dotted);
  }
  return false;
}

async function resolvePublicHost(hostname: string): Promise<ResolvedHost> {
  return resolveSagaNewsPublicHost(hostname);
}

function pinnedHttpsTextRequest(url: URL, resolvedHost: ResolvedHost, policy: SagaNewsOutboundPolicy): Promise<SagaNewsTextResponse> {
  const maxBytes = boundedInteger(policy.maxBytes, SAGA_NEWS_MAX_RESPONSE_BYTES, 1, SAGA_NEWS_MAX_RESPONSE_BYTES);
  const timeoutMs = boundedInteger(policy.timeoutMs, SAGA_NEWS_FETCH_TIMEOUT_MS, 1_000, 30_000);
  return new Promise<SagaNewsTextResponse>((resolve, reject) => {
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      request.destroy();
      reject(error instanceof Error ? error : new SagaNewsCoreError("provider_unavailable", "Källan kunde inte hämtas säkert.", 502));
    };
    const succeed = (value: SagaNewsTextResponse) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const request = httpsRequest({
      signal: executionAbortSignal(),
      protocol: "https:",
      hostname: url.hostname,
      path: `${url.pathname}${url.search}`,
      method: "GET",
      agent: false,
      servername: url.hostname,
      headers: {
        accept: policy.acceptedContentTypes.join(", "),
        "accept-encoding": "identity",
        "user-agent": "SAGA-News-Core/1.0",
      },
      lookup: ((_hostname: string, _options: unknown, callback: (error: Error | null, address: string, family: number) => void) => {
        callback(null, resolvedHost.address, resolvedHost.family);
      }) as never,
    }, (incoming) => {
      const status = incoming.statusCode ?? 502;
      const headers = incoming.headers;
      if (status >= 300 && status < 400) {
        incoming.resume();
        fail(new SagaNewsCoreError("outbound_response", "Källans endpoint omdirigerar. Konfigurera den slutliga HTTPS-adressen i stället.", 502));
        return;
      }
      if (status < 200 || status >= 300) {
        incoming.resume();
        fail(new SagaNewsCoreError("provider_unavailable", `Källan svarade med status ${status}.`, 502));
        return;
      }
      const contentLength = Number(headers["content-length"] ?? 0);
      if (Number.isFinite(contentLength) && contentLength > maxBytes) {
        incoming.resume();
        fail(new SagaNewsCoreError("outbound_response", "Källans svar är större än den säkra läsgränsen.", 422));
        return;
      }
      const contentEncoding = String(headers["content-encoding"] ?? "identity").trim().toLowerCase();
      if (contentEncoding && contentEncoding !== "identity") {
        incoming.resume();
        fail(new SagaNewsCoreError("outbound_response", "Källan använder en komprimering som inte kan verifieras säkert.", 422));
        return;
      }
      const contentType = String(headers["content-type"] ?? "").trim().toLowerCase();
      if (!isAllowedContentType(contentType, policy.acceptedContentTypes)) {
        incoming.resume();
        fail(new SagaNewsCoreError("outbound_response", "Källan returnerade en otillåten innehållstyp.", 422));
        return;
      }
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      incoming.on("data", (chunk: Uint8Array | string) => {
        const value = Buffer.from(chunk);
        bytes += value.byteLength;
        if (bytes > maxBytes) {
          const error = new SagaNewsCoreError("outbound_response", "Källans svar är större än den säkra läsgränsen.", 422);
          incoming.destroy(error);
          fail(error);
          return;
        }
        chunks.push(value);
      });
      incoming.once("error", fail);
      incoming.once("end", () => succeed({
        status,
        contentType,
        text: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    request.once("error", fail);
    request.setTimeout(timeoutMs, () => {
      request.destroy(new SagaNewsCoreError("provider_unavailable", "Källan svarade inte inom den säkra tidsgränsen.", 504));
    });
    request.end();
  });
}

function normalizedAllowedHosts(hosts: readonly string[]): string[] {
  const normalized = [...new Set(hosts.map((host) => host.trim().toLowerCase().replace(/\.$/u, "")))];
  if (!normalized.length || normalized.some((host) => !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/u.test(host))) {
    throw new SagaNewsCoreError("configuration", "Källans godkända värdlista är ogiltig.", 422);
  }
  return normalized;
}

function isAllowedContentType(contentType: string, accepted: readonly string[]): boolean {
  const normalized = contentType.split(";", 1)[0]?.trim();
  return Boolean(normalized) && accepted.some((allowed) => normalized === allowed.toLowerCase());
}

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  const numeric = typeof value === "number" ? value : fallback;
  return Number.isInteger(numeric) && numeric >= min && numeric <= max ? numeric : fallback;
}

function ipv6Groups(address: string): number[] | null {
  let value = address.toLowerCase().replace(/^\[|\]$/gu, "").split("%")[0];
  if (!value.includes(":")) return null;
  const dottedIndex = value.lastIndexOf(":");
  const dottedTail = dottedIndex >= 0 ? value.slice(dottedIndex + 1) : "";
  if (dottedTail.includes(".")) {
    const octets = dottedTail.split(".").map(Number);
    if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
    value = `${value.slice(0, dottedIndex)}:${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }
  const halves = value.split("::");
  if (halves.length > 2) return null;
  const parseSide = (side: string): number[] | null => {
    if (!side) return [];
    const values = side.split(":");
    if (values.some((part) => !/^[0-9a-f]{1,4}$/u.test(part))) return null;
    return values.map((part) => Number.parseInt(part, 16));
  };
  const left = parseSide(halves[0]);
  const right = parseSide(halves.length === 2 ? halves[1] : "");
  if (!left || !right) return null;
  if (halves.length === 1) return left.length === 8 ? left : null;
  const zeros = 8 - left.length - right.length;
  return zeros >= 1 ? [...left, ...Array.from({ length: zeros }, () => 0), ...right] : null;
}
