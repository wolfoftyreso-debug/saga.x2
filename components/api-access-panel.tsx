"use client";

import { useEffect, useMemo, useState, useTransition, type FormEvent } from "react";
import styles from "@/components/api-access-panel.module.css";

export const apiAccessScopes = [
  {
    value: "briefs:read",
    label: "Briefar",
    detail: "Läs dagens brief och historik som JSON.",
  },
  {
    value: "feed:json",
    label: "JSON-flöde",
    detail: "Koppla flödet till egna system eller automationer.",
  },
  {
    value: "feed:rss",
    label: "RSS",
    detail: "Följ verifierade uppdateringar i valfri RSS-läsare.",
  },
  {
    value: "feed:sse",
    label: "Liveflöde",
    detail: "Ta emot nya poster direkt via Server-Sent Events.",
  },
] as const;

type ApiAccessScope = (typeof apiAccessScopes)[number]["value"];

export type ApiAccessKey = {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  scopes: ApiAccessScope[];
};

type FeedUrls = {
  briefs?: string;
  json?: string;
  rss?: string;
  sse?: string;
};

type CreatedAccessKey = {
  key: ApiAccessKey;
  plaintextKey: string;
  feeds?: FeedUrls;
};

type ApiAccessPanelProps = {
  /** Optional server-fetched records. The component otherwise loads /api/access-keys itself. */
  initialKeys?: ApiAccessKey[];
  /** Lets the API define public feed routes without changing this UI. */
  feedEndpoints?: FeedUrls;
};

type LoadState = "loading" | "ready" | "error";

const defaultScopes: ApiAccessScope[] = ["briefs:read", "feed:json", "feed:rss"];

function asAccessKey(value: unknown): ApiAccessKey | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const id = readString(record, "id");
  const name = readString(record, "name");
  const prefix = readString(record, "prefix") || readString(record, "keyPrefix");
  const createdAt = readString(record, "createdAt") || readString(record, "created_at");
  if (!id || !name || !prefix || !createdAt) return null;
  const scopes = Array.isArray(record.scopes)
    ? record.scopes.filter((scope): scope is ApiAccessScope => apiAccessScopes.some((option) => option.value === scope))
    : [];
  return {
    id,
    name,
    prefix,
    createdAt,
    lastUsedAt: readString(record, "lastUsedAt") || readString(record, "last_used_at") || null,
    revokedAt: readString(record, "revokedAt") || readString(record, "revoked_at") || null,
    scopes,
  };
}

function readString(record: Record<string, unknown>, key: string) {
  return typeof record[key] === "string" ? record[key] : "";
}

function accessKeysFromPayload(payload: unknown): ApiAccessKey[] {
  if (Array.isArray(payload)) return payload.map(asAccessKey).filter((key): key is ApiAccessKey => Boolean(key));
  if (!payload || typeof payload !== "object") return [];
  const record = payload as Record<string, unknown>;
  const candidates = record.keys ?? record.accessKeys ?? record.items;
  return Array.isArray(candidates) ? candidates.map(asAccessKey).filter((key): key is ApiAccessKey => Boolean(key)) : [];
}

function feedUrlsFromPayload(payload: unknown): FeedUrls | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const record = payload as Record<string, unknown>;
  const feeds = (record.feeds ?? record.feedUrls ?? record.urls) as Record<string, unknown> | undefined;
  if (!feeds || typeof feeds !== "object") return undefined;
  const json = readString(feeds, "json");
  const briefs = readString(feeds, "briefs");
  const rss = readString(feeds, "rss");
  const sse = readString(feeds, "sse");
  return briefs || json || rss || sse ? {
    briefs: briefs || undefined,
    json: json || undefined,
    rss: rss || undefined,
    sse: sse || undefined,
  } : undefined;
}

function createResultFromPayload(payload: unknown): CreatedAccessKey | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const key = asAccessKey(record.key ?? record.accessKey ?? record.item);
  const plaintextKey = readString(record, "plaintextKey") || readString(record, "secret") || readString(record, "token") || readString(record, "apiKey");
  if (!key || !plaintextKey) return null;
  return { key, plaintextKey, feeds: feedUrlsFromPayload(payload) };
}

function formatDateTime(value: string | null) {
  if (!value) return "Aldrig";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("sv-SE", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function appendToken(url: string, token: string) {
  try {
    const parsed = new URL(url, typeof window === "undefined" ? "https://brief.local" : window.location.origin);
    parsed.searchParams.set("token", token);
    return parsed.toString();
  } catch {
    const separator = url.includes("?") ? "&" : "?";
    return `${url}${separator}token=${encodeURIComponent(token)}`;
  }
}

function toAbsoluteUrl(url: string) {
  if (/^https?:\/\//i.test(url)) return url;
  if (typeof window === "undefined") return url;
  return new URL(url, window.location.origin).toString();
}

async function copyText(value: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const field = document.createElement("textarea");
  field.value = value;
  field.style.position = "fixed";
  field.style.opacity = "0";
  document.body.append(field);
  field.select();
  document.execCommand("copy");
  field.remove();
}

export function ApiAccessPanel({ initialKeys, feedEndpoints }: ApiAccessPanelProps) {
  const [keys, setKeys] = useState<ApiAccessKey[]>(initialKeys ?? []);
  const [loadState, setLoadState] = useState<LoadState>(initialKeys ? "ready" : "loading");
  const [notice, setNotice] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedAccessKey | null>(null);
  const [selectedScopes, setSelectedScopes] = useState<ApiAccessScope[]>(defaultScopes);
  const [isCreating, startCreateTransition] = useTransition();
  const [isRevoking, startRevokeTransition] = useTransition();

  useEffect(() => {
    if (initialKeys) return;
    let active = true;
    void (async () => {
      try {
        const response = await fetch("/api/access-keys", { cache: "no-store" });
        const payload = await response.json() as { error?: string };
        if (!response.ok) throw new Error(payload.error ?? "Kunde inte hämta dina API-nycklar.");
        if (!active) return;
        setKeys(accessKeysFromPayload(payload));
        setLoadState("ready");
      } catch (reason) {
        if (!active) return;
        setNotice(reason instanceof Error ? reason.message : "Kunde inte hämta dina API-nycklar.");
        setLoadState("error");
      }
    })();
    return () => {
      active = false;
    };
  }, [initialKeys]);

  const activeKeys = useMemo(() => keys.filter((key) => !key.revokedAt), [keys]);
  const retiredKeys = useMemo(() => keys.filter((key) => key.revokedAt), [keys]);
  const publicFeeds = useMemo<Required<FeedUrls>>(() => ({
    briefs: feedEndpoints?.briefs ?? "/api/v1/briefs",
    json: feedEndpoints?.json ?? "/api/v1/feed",
    rss: feedEndpoints?.rss ?? "/api/v1/rss",
    sse: feedEndpoints?.sse ?? "/api/v1/stream",
  }), [feedEndpoints]);

  function toggleScope(scope: ApiAccessScope) {
    setSelectedScopes((current) => current.includes(scope)
      ? current.filter((value) => value !== scope)
      : [...current, scope]);
    setNotice(null);
  }

  function createKey(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const name = String(form.get("name") ?? "").trim();
    if (!name || selectedScopes.length === 0) {
      setNotice("Skriv ett namn och välj minst ett format.");
      return;
    }

    setNotice(null);
    startCreateTransition(async () => {
      try {
        const response = await fetch("/api/access-keys", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name, scopes: selectedScopes }),
        });
        const payload = await response.json() as { error?: string };
        if (!response.ok) throw new Error(payload.error ?? "Kunde inte skapa API-nyckeln.");
        const result = createResultFromPayload(payload);
        if (!result) throw new Error("Servern skapade nyckeln men skickade inte tillbaka den engångsnyckel som ska visas.");
        setKeys((current) => [result.key, ...current.filter((key) => key.id !== result.key.id)]);
        setLoadState("ready");
        setCreated(result);
        setSelectedScopes(defaultScopes);
        formElement.reset();
        setNotice(null);
      } catch (reason) {
        setNotice(reason instanceof Error ? reason.message : "Kunde inte skapa API-nyckeln.");
      }
    });
  }

  function revokeKey(key: ApiAccessKey) {
    const accepted = window.confirm(`Spärra “${key.name}”? Alla integrationer som använder nyckeln slutar fungera direkt.`);
    if (!accepted) return;
    setNotice(null);
    startRevokeTransition(async () => {
      try {
        const response = await fetch("/api/access-keys", {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: key.id }),
        });
        const payload = await response.json() as { error?: string; key?: unknown; accessKey?: unknown };
        if (!response.ok) throw new Error(payload.error ?? "Kunde inte spärra API-nyckeln.");
        const revoked = asAccessKey(payload.key ?? payload.accessKey);
        setKeys((current) => current.map((item) => item.id === key.id
          ? revoked ?? { ...item, revokedAt: new Date().toISOString() }
          : item));
        setNotice(`“${key.name}” är spärrad.`);
      } catch (reason) {
        setNotice(reason instanceof Error ? reason.message : "Kunde inte spärra API-nyckeln.");
      }
    });
  }

  async function copy(value: string, label: string) {
    try {
      await copyText(value);
      setNotice(`${label} kopierad.`);
    } catch {
      setNotice("Kunde inte kopiera. Markera och kopiera manuellt.");
    }
  }

  const secretFeedUrls = { ...publicFeeds, ...created?.feeds };

  return (
    <section className={styles.panel} aria-labelledby="api-access-title">
      <header className={styles.header}>
        <div>
          <p className="eyebrow">EXTERNA FLÖDEN</p>
          <h2 id="api-access-title">Använd din brief utanför appen.</h2>
          <p>Koppla dina verifierade uppdateringar till ett eget system, en RSS-läsare eller ett liveflöde. En nyckel ger åtkomst bara till de format du väljer.</p>
        </div>
        <span className={styles.headerSeal}><span aria-hidden="true">↗</span> Privat åtkomst</span>
      </header>

      {created && (
        <section className={styles.secretCard} aria-labelledby="created-key-title">
          <div className={styles.secretHeading}>
            <div>
              <p className="eyebrow">SPARA NU</p>
              <h3 id="created-key-title">Din nya API-nyckel visas bara nu.</h3>
              <p>Kopiera den till en lösenordshanterare. När rutan stängs går den inte att visa igen — skapa en ny nyckel om du tappar den.</p>
            </div>
            <button className={styles.dismissButton} type="button" onClick={() => setCreated(null)} aria-label="Dölj API-nyckeln">×</button>
          </div>
          <CopyRow value={created.plaintextKey} label="Kopiera nyckel" onCopy={copy} secret />
          <div className={styles.createdFeeds}>
            <p>Färdiga kopplingsuppgifter för <strong>{created.key.name}</strong></p>
            <FeedRows feeds={secretFeedUrls} secret={created.plaintextKey} onCopy={copy} />
            <p className={styles.credentialWarning}><strong>Varning:</strong> RSS- och live-länken innehåller din nyckel. Behandla dem som lösenord och dela dem inte.</p>
          </div>
        </section>
      )}

      <section className={styles.createSection} aria-labelledby="create-key-title">
        <div className={styles.sectionHeading}>
          <div>
            <p className="eyebrow">NY NYCKEL</p>
            <h3 id="create-key-title">Skapa en åtkomstnyckel.</h3>
          </div>
          <span>En nyckel per integration</span>
        </div>
        <form className={styles.createForm} onSubmit={createKey}>
          <label className={styles.nameField}>
            <span>Namn på integrationen</span>
            <input name="name" required minLength={2} maxLength={80} placeholder="Exempel: Min RSS-läsare" autoComplete="off" />
          </label>
          <fieldset className={styles.scopePicker}>
            <legend>Vad ska nyckeln få läsa?</legend>
            <div>
              {apiAccessScopes.map((scope) => {
                const selected = selectedScopes.includes(scope.value);
                return (
                  <label className={selected ? styles.scopeSelected : undefined} key={scope.value}>
                    <input type="checkbox" checked={selected} onChange={() => toggleScope(scope.value)} />
                    <span><strong>{scope.label}</strong><small>{scope.detail}</small></span>
                  </label>
                );
              })}
            </div>
          </fieldset>
          <div className={styles.createActions}>
            <button className="primary-button" type="submit" disabled={isCreating}>{isCreating ? "Skapar…" : "Skapa API-nyckel"}</button>
            <span>Nyckeln visas exakt en gång.</span>
          </div>
        </form>
      </section>

      <section className={styles.feedSection} aria-labelledby="feed-links-title">
        <div className={styles.sectionHeading}>
          <div>
            <p className="eyebrow">FORMAT OCH URL:ER</p>
            <h3 id="feed-links-title">Kopplingspunkter.</h3>
          </div>
          <span>Nyckel krävs</span>
        </div>
        <p className={styles.feedIntro}>JSON använder headern <code>Authorization: Bearer DIN_API_NYCKEL</code>. RSS och live använder <code>?token=DIN_API_NYCKEL</code>. De nedan innehåller ingen hemlighet.</p>
        <FeedRows feeds={publicFeeds} onCopy={copy} />
      </section>

      <section className={styles.keySection} aria-labelledby="active-keys-title">
        <div className={styles.sectionHeading}>
          <div>
            <p className="eyebrow">AKTIVA NYCKLAR</p>
            <h3 id="active-keys-title">Åtkomst som är igång.</h3>
          </div>
          <span>{activeKeys.length} aktiva</span>
        </div>
        {loadState === "loading" && <p className={styles.loading}>Hämtar åtkomstnycklar…</p>}
        {loadState === "error" && <p className="form-error">Kunde inte hämta nycklar. Försök ladda om sidan.</p>}
        {loadState === "ready" && !activeKeys.length && <p className={styles.empty}>Inga aktiva nycklar. Skapa en först när du ska koppla ett externt flöde.</p>}
        {activeKeys.length > 0 && (
          <ul className={styles.keyList}>
            {activeKeys.map((key) => <AccessKeyRow key={key.id} accessKey={key} isRevoking={isRevoking} onRevoke={revokeKey} />)}
          </ul>
        )}
      </section>

      {retiredKeys.length > 0 && (
        <details className={styles.retiredKeys}>
          <summary>Spärrade nycklar ({retiredKeys.length})</summary>
          <ul className={styles.keyList}>
            {retiredKeys.map((key) => <AccessKeyRow key={key.id} accessKey={key} isRevoking={false} onRevoke={revokeKey} />)}
          </ul>
        </details>
      )}

      {notice && <p className={notice.startsWith("Kunde") || notice.startsWith("Skriv") || notice.startsWith("Servern") ? "form-error" : "form-success"} role="status">{notice}</p>}
    </section>
  );
}

function FeedRows({ feeds, secret, onCopy }: { feeds: Required<FeedUrls> | FeedUrls; secret?: string; onCopy: (value: string, label: string) => Promise<void> }) {
  const rows = [
    { key: "briefs", name: "BRIEF", detail: "Hela publicerade briefar", url: feeds.briefs },
    { key: "json", name: "JSON", detail: "Strukturerade briefar och händelser", url: feeds.json },
    { key: "rss", name: "RSS", detail: "Följ i en RSS-läsare", url: feeds.rss },
    { key: "sse", name: "LIVE", detail: "Nya poster via Server-Sent Events", url: feeds.sse },
  ] as const;

  return (
    <div className={styles.feedRows}>
      {rows.map((row) => {
        if (!row.url) return null;
        const baseUrl = toAbsoluteUrl(row.url);
        const value = row.key === "json" || row.key === "briefs" ? baseUrl : appendToken(baseUrl, secret ?? "DIN_API_NYCKEL");
        const authentication = row.key === "json" || row.key === "briefs"
          ? `Authorization: Bearer ${secret ?? "DIN_API_NYCKEL"}`
          : secret
            ? "Färdig privat länk"
            : "Byt ut DIN_API_NYCKEL mot en aktiv nyckel";
        return (
          <div className={styles.feedRow} key={row.key}>
            <span className={styles.feedType}>{row.name}</span>
            <span className={styles.feedCopy}><strong>{row.detail}</strong><code>{value}</code><small>{authentication}</small></span>
            <button className={styles.copyButton} type="button" onClick={() => void onCopy(value, `${row.name}-URL`)}>Kopiera URL</button>
          </div>
        );
      })}
    </div>
  );
}

function CopyRow({ value, label, onCopy, secret = false }: { value: string; label: string; onCopy: (value: string, label: string) => Promise<void>; secret?: boolean }) {
  return (
    <div className={`${styles.copyRow}${secret ? ` ${styles.copyRowSecret}` : ""}`}>
      <code>{value}</code>
      <button className={styles.copyButton} type="button" onClick={() => void onCopy(value, label)}>{label}</button>
    </div>
  );
}

function AccessKeyRow({ accessKey, isRevoking, onRevoke }: { accessKey: ApiAccessKey; isRevoking: boolean; onRevoke: (key: ApiAccessKey) => void }) {
  const scopeText = accessKey.scopes.length
    ? accessKey.scopes.map((scope) => apiAccessScopes.find((option) => option.value === scope)?.label ?? scope).join(" · ")
    : "Inga format valda";
  const revoked = Boolean(accessKey.revokedAt);
  return (
    <li className={`${styles.keyRow}${revoked ? ` ${styles.keyRowRevoked}` : ""}`}>
      <div className={styles.keyIdentity}>
        <strong>{accessKey.name}</strong>
        <code>{accessKey.prefix}••••••••</code>
      </div>
      <div className={styles.keyMeta}>
        <span>{scopeText}</span>
        <span>Skapad {formatDateTime(accessKey.createdAt)}</span>
        <span>{revoked ? `Spärrad ${formatDateTime(accessKey.revokedAt)}` : `Senast använd ${formatDateTime(accessKey.lastUsedAt)}`}</span>
      </div>
      {!revoked && <button className={styles.revokeButton} type="button" disabled={isRevoking} onClick={() => onRevoke(accessKey)}>{isRevoking ? "Spärrar…" : "Spärra"}</button>}
    </li>
  );
}
