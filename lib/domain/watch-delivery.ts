import type { EventStatus, UpdateKind } from "@/lib/domain/types";

export type WatchDeliveryState = "pending" | "delivering" | "delivered" | "failed" | "suppressed";

export type WatchDeliverySnapshot = {
  state: WatchDeliveryState;
  attemptCount: number;
  nextAttemptAt: string | null;
  claimedAt: string | null;
};

const retryDelaysMs = [30_000, 2 * 60_000, 10 * 60_000, 30 * 60_000, 2 * 60 * 60_000, 6 * 60 * 60_000];

/** One setting must visibly change output: false means send a quiet check-in too. */
export function shouldDeliverBriefToConversation(itemCount: number, onlyWhenChanged: boolean): boolean {
  return shouldCreateBriefRecord(itemCount, onlyWhenChanged);
}

/** A quiet, only-when-changed pass is a run record, never a user-visible brief. */
export function shouldCreateBriefRecord(itemCount: number, onlyWhenChanged: boolean): boolean {
  return itemCount > 0 || !onlyWhenChanged;
}

/** Delivery rows are retried safely only when they are due or an abandoned claim expired. */
export function canAttemptWatchDelivery(delivery: WatchDeliverySnapshot, now = new Date()): boolean {
  if (delivery.state === "delivered" || delivery.state === "suppressed") return false;
  if (delivery.state === "delivering") return Boolean(delivery.claimedAt && isClaimExpired(delivery.claimedAt, now));
  if (!delivery.nextAttemptAt) return true;
  return new Date(delivery.nextAttemptAt).getTime() <= now.getTime();
}

export function isClaimExpired(claimedAt: string, now = new Date(), claimTimeoutMs = 10 * 60_000): boolean {
  const claimedAtMs = new Date(claimedAt).getTime();
  return Number.isFinite(claimedAtMs) && claimedAtMs <= now.getTime() - claimTimeoutMs;
}

export function nextWatchDeliveryAttempt(attemptCount: number, now = new Date()): string {
  const delay = retryDelaysMs[Math.min(Math.max(attemptCount - 1, 0), retryDelaysMs.length - 1)];
  return new Date(now.getTime() + delay).toISOString();
}

export function watchMatchesMaterialChange(input: {
  triggerStatuses: string[];
  onlyMaterialChange: boolean;
  nextStatus: EventStatus;
  updateKind: UpdateKind;
}): boolean {
  const statuses = input.triggerStatuses;
  if (!statuses.length) return false;
  const materialKind = input.updateKind !== "no_material_change";
  if (input.onlyMaterialChange && !materialKind) return false;
  if (statuses.includes(input.nextStatus)) return true;
  if (!statuses.includes("changed")) return false;
  // For a topic watch, a verified new event is itself the most material kind
  // of change. Event-bound watches never see a different event here, so this
  // does not turn an existing event watch into a noisy discovery feed.
  if (input.updateKind === "new_event") return true;
  return input.updateKind === "status_change"
    || input.updateKind === "terms_change"
    || input.updateKind === "impact_change"
    || input.updateKind === "effective_date_change"
    || input.updateKind === "verification_change";
}
