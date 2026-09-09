import { describe, expect, it, vi } from "vitest";
import {
  deleteContentAutomationRule,
  updateContentAutomationRule,
} from "@/lib/services/content-studio";

type Filter = { column: string; value: unknown };

/**
 * A deliberately small query double: it only returns a rule when both the
 * durable rule id and owner id have been included in the database query.
 * This protects the service contract from a future accidental service-role
 * write that filters by id alone.
 */
function ownerScopedRuleClient(ownerId: string, ruleId: string) {
  const filters: Filter[] = [];
  const update = vi.fn();
  const query = {
    select: () => query,
    delete: () => query,
    update: (value: unknown) => {
      update(value);
      return query;
    },
    eq: (column: string, value: unknown) => {
      filters.push({ column, value });
      return query;
    },
    maybeSingle: async () => {
      const ownsRule = filters.some((filter) => filter.column === "id" && filter.value === ruleId)
        && filters.some((filter) => filter.column === "user_id" && filter.value === ownerId);
      return { data: ownsRule ? { id: ruleId } : null, error: null };
    },
  };

  return {
    client: { from: vi.fn(() => query) } as never,
    filters,
    update,
  };
}

describe("ägarskap för innehållsautomationer", () => {
  it("tar inte bort en annan användares regel även om id:t är känt", async () => {
    const database = ownerScopedRuleClient("owner-a", "rule-a");

    await expect(deleteContentAutomationRule(database.client, "owner-b", "rule-a")).resolves.toBe(false);
    expect(database.filters).toEqual(expect.arrayContaining([
      { column: "id", value: "rule-a" },
      { column: "user_id", value: "owner-b" },
    ]));
  });

  it("stoppar en paus- eller återupptagningspatch före skrivning när regeln inte ägs", async () => {
    const database = ownerScopedRuleClient("owner-a", "rule-a");

    await expect(updateContentAutomationRule(database.client, "owner-b", "rule-a", { active: false })).resolves.toBeNull();
    expect(database.update).not.toHaveBeenCalled();
  });
});
