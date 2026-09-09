"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { WatchView } from "@/lib/services/workspace";
import { StatusChip } from "@/components/status-chip";

const statusLabels: Record<string, string> = {
  signed: "undertecknas",
  adopted: "antas",
  effective: "träder i kraft",
  implemented: "implementeras",
  changed: "ändras",
  reversed: "upphävs",
};

export function WatchList({ watches }: { watches: WatchView[] }) {
  return (
    <ol className="watch-cards">
      {watches.map((watch) => <WatchCard key={watch.id} watch={watch} />)}
    </ol>
  );
}

function WatchCard({ watch }: { watch: WatchView }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const paused = watch.state === "paused";

  function mutate(action: "pause" | "resume" | "delete") {
    setError(null);
    startTransition(async () => {
      try {
        const response = await fetch("/api/watches", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: watch.id, action }),
        });
        const payload = await response.json() as { error?: string };
        if (!response.ok) throw new Error(payload.error ?? "Kunde inte uppdatera bevakningen.");
        router.refresh();
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : "Kunde inte uppdatera bevakningen.");
      }
    });
  }

  const triggers = watch.triggerStatuses.map((status) => statusLabels[status] ?? status).join(", ");
  return (
    <li className="watch-card">
      <div className="watch-card-topline">
        <span className={`watch-state ${watch.state}`}>{watch.state === "active" ? "Aktiv" : watch.state === "paused" ? "Pausad" : "Klar"}</span>
        {watch.event && <StatusChip status={watch.event.status} />}
      </div>
      <h2>
        {watch.eventId ? (
          <Link className="watch-event-link" href={`/events/${watch.eventId}`}>
            {watch.title}
          </Link>
        ) : watch.title}
      </h2>
      {watch.rationale && <p>{watch.rationale}</p>}
      <div className="watch-rule"><strong>Hör av dig när:</strong> {triggers || "något materiellt förändras"}</div>
      {watch.lastTriggeredAt && <span className="watch-last">Senast berörd: {new Intl.DateTimeFormat("sv-SE", { dateStyle: "medium" }).format(new Date(watch.lastTriggeredAt))}</span>}
      <div className="watch-actions">
        {watch.state !== "completed" && <button className="secondary-button" type="button" disabled={isPending} onClick={() => mutate(paused ? "resume" : "pause")}>{paused ? "Återuppta" : "Pausa"}</button>}
        <button className="text-action danger" type="button" disabled={isPending} onClick={() => mutate("delete")}>Ta bort</button>
      </div>
      {error && <p className="form-error">{error}</p>}
    </li>
  );
}
