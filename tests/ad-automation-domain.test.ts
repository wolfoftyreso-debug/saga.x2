import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  adAutomationCreateSchema,
  adAutomationInputSchema,
  adAutomationUpdateSchema,
} from "@/lib/domain/ad-automation";
import { validAdAutomationCreateInput, validAdAutomationInput } from "@/tests/fixtures/ad-automation";

describe("SAGA ad automation workflow contract", () => {
  it("accepts a complete draft-first manual canvas with no credentials", () => {
    const parsed = adAutomationInputSchema.parse(validAdAutomationInput());
    expect(parsed.workflow.creative.creativeBrief.hook).toContain("bilaffären");
    expect(parsed.workflow.review.required).toBe(true);
    expect(parsed.workflow.destinations[0]).not.toHaveProperty("accessToken");
  });

  it("keeps external credential-shaped fields out of a saved destination", () => {
    const result = adAutomationInputSchema.safeParse(validAdAutomationInput({
      workflow: {
        ...validAdAutomationInput().workflow,
        destinations: [{
          ...validAdAutomationInput().workflow.destinations[0],
          accessToken: "never-store-this",
        }],
      },
    }));
    expect(result.success).toBe(false);
  });

  it("does not let a browser self-attest that a commercial offer is verified", () => {
    const input = validAdAutomationInput();
    const result = adAutomationInputSchema.safeParse({
      ...input,
      workflow: {
        ...input.workflow,
        creative: {
          ...input.workflow.creative,
          creativeBrief: {
            ...input.workflow.creative.creativeBrief,
            offer: {
              ...input.workflow.creative.creativeBrief.offer,
              verification: {
                status: "verified",
                sourceReference: "Jag säger att det är sant.",
                verifiedAt: "2026-08-25T09:00:00.000Z",
              },
            },
          },
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it("allows only a complete scheduled canvas to be active", () => {
    expect(adAutomationInputSchema.safeParse(validAdAutomationInput({ active: true })).success).toBe(false);

    const scheduled = validAdAutomationInput({
      active: true,
      workflow: {
        ...validAdAutomationInput().workflow,
        trigger: { kind: "schedule" as const, summary: "Varje tisdag" },
        schedule: {
          mode: "weekly_count" as const,
          timezone: "Europe/Stockholm",
          weeklyCount: 1,
          weekdays: [2],
          localTimes: ["09:00"],
          cronExpression: null,
          startsOn: null,
          endsOn: null,
        },
        creative: {
          ...validAdAutomationInput().workflow.creative,
          creativeBrief: {
            ...validAdAutomationInput().workflow.creative.creativeBrief,
            customVisualDirection: "",
          },
        },
      },
    });
    expect(adAutomationInputSchema.safeParse(scheduled).success).toBe(true);
    expect(adAutomationInputSchema.safeParse({ ...scheduled, active: false }).success).toBe(true);
  });

  it("keeps advisory custom visual prompts out of scheduled V1 flows", () => {
    const input = validAdAutomationInput();
    const scheduledWithCustomDirection = {
      ...input,
      active: false,
      workflow: {
        ...input.workflow,
        trigger: { kind: "schedule" as const, summary: null },
        schedule: {
          mode: "weekly_count" as const,
          timezone: "Europe/Stockholm",
          weeklyCount: 1,
          weekdays: [1],
          localTimes: ["09:00"],
          cronExpression: null,
          startsOn: null,
          endsOn: null,
        },
      },
    };
    expect(adAutomationInputSchema.safeParse(scheduledWithCustomDirection).success).toBe(false);
  });

  it("requires a revision whenever a saved canvas is patched", () => {
    expect(adAutomationUpdateSchema.safeParse({ name: "Nytt namn" }).success).toBe(false);
    expect(adAutomationUpdateSchema.safeParse({ name: "Nytt namn", expectedRevision: 2 }).success).toBe(true);
  });

  it("requires a create idempotency key and keeps it outside the workflow", () => {
    expect(adAutomationCreateSchema.safeParse(validAdAutomationInput()).success).toBe(false);
    expect(adAutomationCreateSchema.safeParse(validAdAutomationCreateInput()).success).toBe(true);
  });

  it("ships a Vercel/Neon-only receipt migration with no provider delivery path", () => {
    const migration = readFileSync(resolve(process.cwd(), "db/migrations/202608250009_neon_ad_automations.sql"), "utf8");
    expect(migration).toContain("create table if not exists studio_ad_automations");
    expect(migration).toContain("create table if not exists studio_ad_automation_test_receipts");
    expect(migration).toContain("idempotency_key");
    expect(migration).toContain("state = 'queued'");
    const schedulerMigration = readFileSync(resolve(process.cwd(), "db/migrations/202608250010_neon_ad_automation_scheduler.sql"), "utf8");
    const schedulerUpgrade = readFileSync(resolve(process.cwd(), "db/migrations/202608250011_neon_ad_automation_scheduler_upgrade.sql"), "utf8");
    expect(schedulerMigration).toContain("workflow_revision");
    expect(schedulerUpgrade).toContain("lease_expires_at");
    expect(migration.toLowerCase()).not.toContain("supabase");
  });
});
