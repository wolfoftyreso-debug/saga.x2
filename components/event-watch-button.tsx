"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

export function EventWatchButton({ eventId, compact = false }: { eventId: string; compact?: boolean }) {
  const router = useRouter();
  const [state, setState] = useState<"idle" | "saved" | "error">("idle");
  const [isPending, startTransition] = useTransition();

  function addWatch() {
    if (isPending || state === "saved") return;
    startTransition(async () => {
      try {
        const response = await fetch("/api/chat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ message: "Bevaka detta och säg till när status ändras, antas, träder i kraft eller upphävs.", eventId }),
        });
        const payload = await response.json() as { error?: string };
        if (!response.ok) throw new Error(payload.error ?? "Kunde inte skapa bevakningen.");
        setState("saved");
        router.refresh();
      } catch {
        setState("error");
      }
    });
  }

  return (
    <button className={compact ? "text-action compact" : "text-action"} type="button" onClick={addWatch} disabled={isPending || state === "saved"}>
      {state === "saved" ? "Bevakning skapad" : state === "error" ? "Försök igen" : isPending ? "Sparar…" : "Bevaka status"}
    </button>
  );
}
