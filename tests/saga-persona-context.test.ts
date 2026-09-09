import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { AppActor } from "@/lib/neon/auth-repository";
import type { NeonSql } from "@/lib/neon/database";
import {
  SAGA_PERSONA_SENSITIVE_STORAGE_CONSENT_VERSION,
  normalizeSagaPersonaContext,
  normalizeSagaPersonaHomepage,
  sagaPersonaContextInputSchema,
  type SagaPersonaContextInput,
} from "@/lib/domain/saga-persona-context";
import {
  deleteSagaPersonaContext,
  getSagaPersonaContext,
  getSagaPersonaPrivateVisualContext,
  replaceSagaPersonaContext,
  SagaPersonaContextAccessError,
} from "@/lib/neon/saga-persona-context-repository";

const actor: AppActor = {
  userId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  role: "owner",
  email: "owner@example.com",
  displayName: "Owner",
};

function privateInput(overrides: Partial<SagaPersonaContextInput> = {}): SagaPersonaContextInput {
  return {
    selfDescription: "Jag bygger system som frigör tid för människor.",
    heightCm: 181,
    clothing: ["mörk skjorta", "arbetsjacka"],
    environments: ["skogskant", "verkstad"],
    visualCountries: ["Sverige"],
    interests: ["systemdesign", "natur"],
    workSummary: "Grundare och systembyggare.",
    roles: ["grundare"],
    organizations: [{ name: "SAGA", role: "grundare" }],
    websites: [{ label: "SAGA", url: "https://example.com/" }],
    political: { mode: "self_described", description: "Jag delar detta endast när jag själv väljer det." },
    religion: { mode: "neutral", description: null },
    origin: "Frivillig egen beskrivning.",
    birthCountry: "Sverige",
    visualContextConsent: true,
    sensitiveDataStorageConsent: {
      accepted: true,
      version: SAGA_PERSONA_SENSITIVE_STORAGE_CONSENT_VERSION,
    },
    ...overrides,
  };
}

function contextRow(overrides: Record<string, unknown> = {}) {
  return {
    revision: 1,
    payload: normalizeSagaPersonaContext(sagaPersonaContextInputSchema.parse(privateInput())),
    created_at: "2026-08-26T08:00:00.000Z",
    updated_at: "2026-08-26T08:00:00.000Z",
    ...overrides,
  };
}

function sqlWith(...responses: unknown[]) {
  const query = vi.fn();
  for (const response of responses) query.mockResolvedValueOnce(response);
  return { sql: { query } as unknown as NeonSql, query };
}

describe("SAGA private persona domain", () => {
  it("stores sensitive political/religious fields only when the owner explicitly self-describes them", () => {
    const explicit = sagaPersonaContextInputSchema.safeParse(privateInput());
    expect(explicit.success).toBe(true);

    const missingDescription = sagaPersonaContextInputSchema.safeParse(privateInput({
      political: { mode: "self_described", description: undefined },
    }));
    expect(missingDescription.success).toBe(false);

    const neutralWithDescription = sagaPersonaContextInputSchema.safeParse(privateInput({
      religion: { mode: "neutral", description: "Detta ska aldrig smygsparas." },
    }));
    expect(neutralWithDescription.success).toBe(false);

    const omitted = normalizeSagaPersonaContext(sagaPersonaContextInputSchema.parse({}));
    expect(omitted.political).toEqual({ mode: "not_specified", description: null });
    expect(omitted.religion).toEqual({ mode: "not_specified", description: null });
    expect(omitted.visualContextConsent).toBe(false);

    const missingStorageReceipt = sagaPersonaContextInputSchema.safeParse(privateInput({
      sensitiveDataStorageConsent: undefined,
    }));
    expect(missingStorageReceipt.success).toBe(false);

    const unnecessaryStorageReceipt = sagaPersonaContextInputSchema.safeParse({
      political: { mode: "not_specified" },
      religion: { mode: "not_specified" },
      sensitiveDataStorageConsent: {
        accepted: true,
        version: SAGA_PERSONA_SENSITIVE_STORAGE_CONSENT_VERSION,
      },
    });
    expect(unnecessaryStorageReceipt.success).toBe(false);
  });

  it("accepts only canonical display-only public HTTPS homepages and never fetches them", () => {
    expect(normalizeSagaPersonaHomepage("https://EXAMPLE.com/")).toBe("https://example.com/");
    for (const unsafe of [
      "http://example.com/",
      "https://user:password@example.com/",
      "https://127.0.0.1/",
      "https://[::1]/",
      "https://localhost/",
      "https://api.internal/",
      "https://example.com/private",
      "https://example.com/?token=secret",
      "https://example.com/#token",
    ]) {
      expect(normalizeSagaPersonaHomepage(unsafe)).toBeNull();
    }
  });
});

describe("SAGA private persona repository", () => {
  it("reads only actor-owned context within the actor workspace", async () => {
    const { sql, query } = sqlWith([contextRow()]);
    const context = await getSagaPersonaContext(actor, sql);
    expect(context).toMatchObject({ revision: 1, heightCm: 181, modelUse: { activeIntegration: false } });
    expect(query.mock.calls[0]?.[0]).toContain("workspace_id = $1::uuid");
    expect(query.mock.calls[0]?.[0]).toContain("owner_user_id = $2::uuid");
    expect(query.mock.calls[0]?.[1]).toEqual([actor.workspaceId, actor.userId]);
  });

  it("denies editors and viewers before any persona query, including read/write/delete", async () => {
    for (const role of ["editor", "viewer"] as const) {
      const { sql, query } = sqlWith();
      const scopedActor = { ...actor, role };
      await expect(getSagaPersonaContext(scopedActor, sql)).rejects.toBeInstanceOf(SagaPersonaContextAccessError);
      await expect(replaceSagaPersonaContext(scopedActor, privateInput(), sql)).rejects.toBeInstanceOf(SagaPersonaContextAccessError);
      await expect(deleteSagaPersonaContext(scopedActor, sql)).rejects.toBeInstanceOf(SagaPersonaContextAccessError);
      expect(query).not.toHaveBeenCalled();
    }
  });

  it("writes through the owner-bound revision function and never receives a client scope", async () => {
    const { sql, query } = sqlWith([{ revision: 2 }], [contextRow({ revision: 2 })]);
    const context = await replaceSagaPersonaContext(actor, privateInput({ expectedRevision: 1 }), sql);
    expect(context.revision).toBe(2);
    expect(query.mock.calls[0]?.[0]).toContain("saga_persona_context_write");
    expect(query.mock.calls[0]?.[1]).toEqual([
      actor.workspaceId,
      actor.userId,
      expect.any(String),
      1,
      SAGA_PERSONA_SENSITIVE_STORAGE_CONSENT_VERSION,
    ]);
    expect(query.mock.calls[1]?.[0]).toContain("owner_user_id = $2::uuid");
  });

  it("selects only consented non-sensitive visual fields for the future server-only seam", async () => {
    const { sql, query } = sqlWith([{
      clothing: JSON.stringify(["mörk skjorta"]),
      environments: JSON.stringify(["skogskant"]),
      visual_countries: JSON.stringify(["Sverige"]),
    }]);
    const visual = await getSagaPersonaPrivateVisualContext(actor, sql);
    expect(visual).toEqual({
      source: "self_described",
      clothing: ["mörk skjorta"],
      environments: ["skogskant"],
      visualCountries: ["Sverige"],
    });
    const statement = query.mock.calls[0]?.[0] as string;
    expect(statement).toContain("payload -> 'clothing'");
    expect(statement).toContain("payload -> 'environments'");
    expect(statement).toContain("payload -> 'visualCountries'");
    expect(statement).toContain("visual_context_consent = true");
    expect(statement).not.toContain("political");
    expect(statement).not.toContain("religion");
    expect(statement).not.toContain("origin");
    expect(statement).not.toContain("birthCountry");
    expect(statement).not.toContain("heightCm");
    expect(statement).not.toContain("websites");
  });

  it("erases only the actor-owned parent row; the migration cascades all revisions", async () => {
    const { sql, query } = sqlWith([{ revision: 2 }]);
    await expect(deleteSagaPersonaContext(actor, sql)).resolves.toBe(true);
    expect(query.mock.calls[0]?.[0]).toContain("delete from saga_persona_contexts");
    expect(query.mock.calls[0]?.[0]).toContain("owner_user_id = $2::uuid");
    expect(query.mock.calls[0]?.[1]).toEqual([actor.workspaceId, actor.userId]);

    const migration018 = readFileSync("db/migrations/202608260018_neon_saga_persona_context.sql", "utf8");
    const migration019 = readFileSync("db/migrations/202608260019_neon_saga_persona_sensitive_storage_consent.sql", "utf8");
    expect(migration018).toContain("references saga_persona_contexts(workspace_id, owner_user_id)");
    expect(migration018).toContain("on delete cascade");
    expect(migration018).toContain("saga_persona_context_revision_is_immutable");
    expect(migration018).toContain("model_integration_status text not null default 'disabled'");
    expect(migration018).toContain("publication_scope text not null default 'excluded'");
    expect(migration019).toContain("saga_persona_sensitive_storage_consents");
    expect(migration019).toContain("references saga_persona_context_revisions(workspace_id, owner_user_id, revision)");
    expect(migration019).toContain("saga_persona_context_payload_has_sensitive_data");
    expect(migration019).toContain("target_sensitive_storage_consent_version is distinct from");
  });
});
