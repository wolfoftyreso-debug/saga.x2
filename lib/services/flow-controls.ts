import type { SupabaseClient } from "@supabase/supabase-js";
import { defaultFlowControlsView, flowControlsSchema, type FlowControls, type FlowControlsView } from "@/lib/domain/flow-controls";

type RawRecord = Record<string, unknown>;
type DatabaseClient = SupabaseClient;

function databaseError(context: string, error: { message?: string } | null): Error {
  return new Error(`${context}${error?.message ? `: ${error.message}` : ""}`);
}

/**
 * The default is deliberate and backward-compatible: older accounts get the
 * exact complete brief they had before this table existed until they save a
 * choice of their own.
 */
export async function getFlowControls(client: DatabaseClient, userId: string): Promise<FlowControlsView> {
  const { data, error } = await client
    .from("profile_flow_controls")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw databaseError("Kunde inte läsa flödesinställningarna", error);
  if (!data) return defaultFlowControlsView();
  return mapFlowControls(data as RawRecord);
}

export async function updateFlowControls(client: DatabaseClient, userId: string, controls: FlowControls): Promise<FlowControlsView> {
  const parsed = flowControlsSchema.parse(controls);
  const { data, error } = await client
    .from("profile_flow_controls")
    .upsert({
      user_id: userId,
      world_pulse_enabled: parsed.modules.worldPulse,
      weekly_recap_enabled: parsed.modules.weeklyRecap,
      strategic_radar_enabled: parsed.modules.strategicRadar,
      market_snapshot_enabled: parsed.modules.marketSnapshot,
      company_focus_enabled: parsed.modules.companyFocus,
      direct_alerts_enabled: parsed.alerts.enabled,
      quiet_hours_enabled: parsed.alerts.quietHours.enabled,
      quiet_hours_start: parsed.alerts.quietHours.start,
      quiet_hours_end: parsed.alerts.quietHours.end,
      allow_systemic_during_quiet_hours: parsed.alerts.quietHours.allowSystemicDuringQuietHours,
    }, { onConflict: "user_id" })
    .select("*")
    .single();
  if (error || !data) throw databaseError("Kunde inte spara flödesinställningarna", error);
  return mapFlowControls(data as RawRecord);
}

export function mapFlowControls(row: RawRecord): FlowControlsView {
  const defaults = defaultFlowControlsView();
  const controls = flowControlsSchema.parse({
    modules: {
      worldPulse: booleanValue(row.world_pulse_enabled, defaults.modules.worldPulse),
      weeklyRecap: booleanValue(row.weekly_recap_enabled, defaults.modules.weeklyRecap),
      strategicRadar: booleanValue(row.strategic_radar_enabled, defaults.modules.strategicRadar),
      marketSnapshot: booleanValue(row.market_snapshot_enabled, defaults.modules.marketSnapshot),
      companyFocus: booleanValue(row.company_focus_enabled, defaults.modules.companyFocus),
    },
    alerts: {
      enabled: booleanValue(row.direct_alerts_enabled, defaults.alerts.enabled),
      quietHours: {
        enabled: booleanValue(row.quiet_hours_enabled, defaults.alerts.quietHours.enabled),
        start: timeValue(row.quiet_hours_start, defaults.alerts.quietHours.start),
        end: timeValue(row.quiet_hours_end, defaults.alerts.quietHours.end),
        allowSystemicDuringQuietHours: booleanValue(
          row.allow_systemic_during_quiet_hours,
          defaults.alerts.quietHours.allowSystemicDuringQuietHours,
        ),
      },
    },
  });
  return {
    ...controls,
    updatedAt: typeof row.updated_at === "string" ? row.updated_at : null,
  };
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function timeValue(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const match = value.match(/^([01]\d|2[0-3]):[0-5]\d/);
  return match?.[0] ?? fallback;
}
