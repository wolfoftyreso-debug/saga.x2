import { describe, expect, it, vi } from "vitest";
import type { AppActor } from "@/lib/neon/auth-repository";
import type { NeonSql } from "@/lib/neon/database";
import {
  createSagaAdobeAuthoringRun, getSagaAdobeAuthoringRun, listSagaAdobeAuthoringRuns,
  prepareSagaAdobeAuthoringRunGeneration, selectSagaAdobeAuthoringCandidate,
  resolveSagaAdobeAuthoringKnowledgeSnapshots,
} from "@/lib/neon/saga-adobe-authoring-repository";
const actor: AppActor = { userId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222", brandProfileId: "33333333-3333-4333-8333-333333333333", role: "owner", email: null, displayName: null };
const foreignId = "44444444-4444-4444-8444-444444444444";
const key = "55555555-5555-4555-8555-555555555555";
function missing() { const query = vi.fn().mockResolvedValue([]); return { sql: { query } as unknown as NeonSql, query }; }
describe("Authoring repository brand ownership", () => {
  it("does not load run bodies or candidates when the ID is outside the selected brand", async () => {
    const db = missing();
    expect(await getSagaAdobeAuthoringRun(actor, foreignId, db.sql)).toBeNull();
    expect(db.query).toHaveBeenCalledTimes(1);
    expect(db.query.mock.calls[0]?.[0]).toContain("run.brand_profile_id = $3::uuid");
    expect(db.query.mock.calls[0]?.[1]).toEqual([actor.workspaceId, foreignId, actor.brandProfileId]);
    expect(await listSagaAdobeAuthoringRuns(actor, db.sql)).toEqual([]);
    expect(db.query.mock.calls[1]?.[1]).toEqual([actor.workspaceId, actor.brandProfileId]);
  });
  it("rejects a foreign-brand reference before invoking the durable creation function", async () => {
    const db = missing();
    await expect(createSagaAdobeAuthoringRun(actor, {
      idempotencyKey: key, referenceDraftId: foreignId, expectedReferenceDraftRevision: 1,
      objective: "Förklara automationens mänskliga värde", prompt: "Skriv konkret och med omsorg.", candidateCount: 2, selectedKnowledgeEntryIds: [], includeAuthorName: false,
    }, db.sql)).rejects.toThrow("Referensutkastet tillhör inte det valda varumärket");
    expect(db.query).toHaveBeenCalledTimes(1);
    expect(db.query.mock.calls[0]?.[1]).toEqual([actor.workspaceId, foreignId, actor.brandProfileId]);
  });
  it("rejects generation and candidate selection before a different brand's run can be mutated", async () => {
    for (const operation of [
      (sql: NeonSql) => prepareSagaAdobeAuthoringRunGeneration(actor, foreignId, { idempotencyKey: key, expectedRunRevision: 1, retryFailed: false }, sql),
      (sql: NeonSql) => selectSagaAdobeAuthoringCandidate(actor, foreignId, key, { idempotencyKey: key, expectedRunRevision: 1, expectedCandidateRevision: 1 }, sql),
    ]) {
      const db = missing();
      await expect(operation(db.sql)).rejects.toThrow("Författarkörningen hittades inte");
      expect(db.query).toHaveBeenCalledTimes(1);
      expect(db.query.mock.calls[0]?.[0]).not.toMatch(/from saga_(prepare|select)_adobe/);
    }
  });
  it("rejects knowledge owned by another brand before summaries reach generation", async () => {
    const db = missing();
    await expect(resolveSagaAdobeAuthoringKnowledgeSnapshots(actor, [foreignId], db.sql)).rejects.toThrow("kunskapsunderlaget saknas");
    expect(db.query.mock.calls[0]?.[0]).toContain("policy.brand_profile_id = $3::uuid");
    expect(db.query.mock.calls[0]?.[1]).toEqual([actor.workspaceId, [foreignId], actor.brandProfileId]);
  });
});
