import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  sagaAdobeAuthoringPreviewSchema,
  sagaAdobeAuthoringRunCreateSchema,
  sagaAdobeAuthoringRunSchema,
} from "@/lib/domain/saga-adobe-authoring";

const runKey = "11111111-1111-4111-8111-111111111111";
const draftId = "22222222-2222-4222-8222-222222222222";
const knowledgeId = "33333333-3333-4333-8333-333333333333";

describe("SAGA Adobe authoring contracts", () => {
  it("accepts only an opaque saved reference and a bounded 1–10 candidate request", () => {
    const parsed = sagaAdobeAuthoringRunCreateSchema.parse({
      idempotencyKey: runKey,
      referenceDraftId: draftId,
      expectedReferenceDraftRevision: 4,
      objective: "Förklara hur välbyggda system frigör mänsklig tid.",
      prompt: "Håll resonemanget jordnära och konkret.",
      includeAuthorName: true,
      selectedKnowledgeEntryIds: [knowledgeId],
      candidateCount: 10,
    });
    expect(parsed).toMatchObject({ referenceDraftId: draftId, candidateCount: 10, selectedKnowledgeEntryIds: [knowledgeId] });
    expect(() => sagaAdobeAuthoringRunCreateSchema.parse({ ...parsed, candidateCount: 11 })).toThrow();
    expect(() => sagaAdobeAuthoringRunCreateSchema.parse({ ...parsed, selectedKnowledgeEntryIds: [knowledgeId, knowledgeId] })).toThrow();
  });

  it("rejects a preview with a client supplied source body or URL", () => {
    const input = {
      contentType: "social_post",
      channels: ["linkedin"],
      topic: "System som frigör tid",
      brief: "Ett jordnära resonemang.",
      voice: "Rak svenska.",
      targetLength: "medium",
      templateInstructions: "",
      desiredCallToAction: "",
      avoid: "",
      imageDirection: "Dokumentärt.",
      language: "sv",
      selectedKnowledgeEntryIds: [knowledgeId],
    };
    expect(sagaAdobeAuthoringPreviewSchema.parse(input).selectedKnowledgeEntryIds).toEqual([knowledgeId]);
    expect(sagaAdobeAuthoringPreviewSchema.safeParse({ ...input, body: "Källtext från klienten" }).success).toBe(false);
    expect(sagaAdobeAuthoringPreviewSchema.safeParse({ ...input, canonicalUrl: "https://example.test" }).success).toBe(false);
  });

  it("makes continuation explicit and never describes it as automatic production", () => {
    const run = sagaAdobeAuthoringRunSchema.parse({
      id: runKey,
      revision: 2,
      state: "generating",
      objective: "Förklara hur välbyggda system frigör mänsklig tid.",
      prompt: "Håll resonemanget jordnära och konkret.",
      includeAuthorName: false,
      candidateCount: 2,
      reference: {
        sourceDraftId: draftId,
        sourceDraftRevision: 4,
        contentType: "social_post",
        channels: ["linkedin"],
        title: "En referens",
        body: "En sparad och tillräckligt lång referenstext för författarserien.",
        language: "sv",
        timezone: "Europe/Stockholm",
        capturedAt: "2026-08-26T12:00:00.000Z",
      },
      knowledge: [],
      candidates: [],
      selectedCandidateId: null,
      selectedDraftId: null,
      selectedDraftHref: null,
      failureMessage: null,
      canGenerate: false,
      canRetry: false,
      canSelect: false,
      hasPendingWork: true,
      canContinue: true,
      generationProgress: {
        total: 2,
        pending: 2,
        completed: 0,
        queued: 2,
        generating: 0,
        ready: 0,
        blocked: 0,
        failed: 0,
        selected: 0,
        notSelected: 0,
      },
      noPublication: true,
      createdAt: "2026-08-26T12:00:00.000Z",
      updatedAt: "2026-08-26T12:00:00.000Z",
    });
    expect(run).toMatchObject({
      canContinue: true,
      hasPendingWork: true,
      generationProgress: { total: 2, pending: 2, queued: 2, completed: 0 },
      noPublication: true,
    });
  });

  it("keeps all authoring generation out of the cron tick and preserves server-only provenance checks in the migration", () => {
    const cron = readFileSync("app/api/cron/tick/route.ts", "utf8");
    const migration = readFileSync("db/migrations/202608260025_neon_saga_adobe_authoring_runs.sql", "utf8");
    const commandMigration = readFileSync("db/migrations/202608260026_neon_saga_adobe_authoring_generation_commands.sql", "utf8");
    expect(cron).not.toContain("saga-adobe-authoring");
    expect(migration).toContain("candidate_count between 1 and 10");
    expect(migration).toContain("saga_adobe_authoring_create_idempotency_conflict");
    expect(migration).toContain("saga_adobe_authoring_generation_idempotency_conflict");
    expect(migration).toContain("saga_adobe_authoring_selection_idempotency_conflict");
    expect(migration).toContain("unique (workspace_id, run_id)");
    expect(migration).toContain("active_receipt_id");
    expect(migration).toContain("saga_adobe_authoring_finalize_receipt");
    expect(migration).toContain("promptPolicyVersion");
    expect(migration).toContain("scheduled_at\n  ) values");
    expect(commandMigration).toContain("saga_adobe_authoring_generation_command_keys");
    expect(commandMigration).toContain("should_process boolean");
    expect(commandMigration).toContain("if command_row.state = 'running' and command_row.lease_expires_at <= now() then");
    expect(commandMigration).toContain("command.claim_token = target_command_claim_token");
    expect(commandMigration).toContain("processed_job_id = target_job_id");
  });
});
