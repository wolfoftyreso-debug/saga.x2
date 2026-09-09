"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";

type BriefRunPayload = {
  error?: unknown;
  briefId?: unknown;
  itemCount?: unknown;
  quietDay?: unknown;
  alreadyPublished?: unknown;
};

type Result = {
  message: string;
  briefId: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function getRunResult(payload: BriefRunPayload): Result {
  const briefId = typeof payload.briefId === "string" ? payload.briefId : null;
  const itemCount = typeof payload.itemCount === "number" ? payload.itemCount : 0;

  if (payload.alreadyPublished === true) {
    return {
      briefId,
      message: briefId
        ? "Dagens kompletta brief finns redan. Jag har inte kört om samma kontroll."
        : "Dagens kontroll är redan klar. Inget väsentligt har publicerats.",
    };
  }

  if (payload.quietDay === true) {
    return { briefId: null, message: "Kontrollen är klar. Inget väsentligt har publicerats." };
  }

  return {
    briefId,
    message: `Kontrollen är klar. ${itemCount} relevant${itemCount === 1 ? " förändring är" : "a förändringar är"} redo att läsa.`,
  };
}

export function RunBriefButton() {
  const router = useRouter();
  const [state, setState] = useState<"idle" | "running" | "success" | "error">("idle");
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setState("running");
    setResult(null);
    setError(null);
    try {
      const response = await fetch("/api/briefs/run", {
        method: "POST",
        headers: { accept: "application/json" },
      });
      const responseBody: unknown = await response.json().catch(() => null);
      const payload = isRecord(responseBody) ? responseBody as BriefRunPayload : {};
      if (!response.ok) {
        throw new Error(typeof payload.error === "string" ? payload.error : "Kunde inte genomföra kontrollen.");
      }

      router.refresh();
      setResult(getRunResult(payload));
      setState("success");
    } catch (error) {
      setState("error");
      setError(error instanceof Error ? error.message : "Kunde inte genomföra kontrollen.");
    }
  }

  return (
    <div className="run-brief-control" aria-busy={state === "running"}>
      <button className="secondary-button compact-button" type="button" onClick={run} disabled={state === "running"}>
        {state === "running" ? "Kontrollerar…" : "Kör kontroll nu"}
      </button>
      {state === "running" && <p className="run-brief-progress" role="status">Söker, verifierar och jämför mot händelseregistret…</p>}
      {state === "success" && result && (
        <p className="form-success run-brief-result" role="status">
          <span>{result.message}</span>
          {result.briefId && <Link href={`/briefs/${result.briefId}`}>Öppna briefen →</Link>}
        </p>
      )}
      {state === "error" && error && <p className="form-error run-brief-result" role="alert">{error}</p>}
    </div>
  );
}
