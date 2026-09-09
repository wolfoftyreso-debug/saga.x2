import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({
  neonConfigurationResponse: vi.fn(),
  requireNeonActor: vi.fn(),
  getContext: vi.fn(),
  replaceContext: vi.fn(),
  deleteContext: vi.fn(),
}));

vi.mock("@/lib/neon/http", () => ({
  neonConfigurationResponse: mocks.neonConfigurationResponse,
  requireNeonActor: mocks.requireNeonActor,
}));
vi.mock("@/lib/neon/saga-persona-context-repository", () => ({
  getSagaPersonaContext: mocks.getContext,
  replaceSagaPersonaContext: mocks.replaceContext,
  deleteSagaPersonaContext: mocks.deleteContext,
  SagaPersonaContextAccessError: class SagaPersonaContextAccessError extends Error {
    constructor(message?: string) { super(message); this.name = "SagaPersonaContextAccessError"; }
  },
  SagaPersonaContextConflictError: class SagaPersonaContextConflictError extends Error {
    constructor(message?: string) { super(message); this.name = "SagaPersonaContextConflictError"; }
  },
  SagaPersonaContextValidationError: class SagaPersonaContextValidationError extends Error {
    constructor(message?: string) { super(message); this.name = "SagaPersonaContextValidationError"; }
  },
}));

import { DELETE, GET, PUT } from "@/app/api/saga/persona-context/route";

const actor = {
  userId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  role: "owner" as const,
  email: null,
  displayName: null,
};

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.neonConfigurationResponse.mockReturnValue(null);
  mocks.requireNeonActor.mockResolvedValue({ actor });
});

describe("SAGA persona context API", () => {
  it("requires configured Neon before resolving an actor and marks responses private", async () => {
    mocks.neonConfigurationResponse.mockReturnValue(NextResponse.json({ error: "configuration" }, {
      status: 503,
      headers: { "cache-control": "no-store" },
    }));
    const response = await GET();
    expect(response.status).toBe(503);
    expect(mocks.requireNeonActor).not.toHaveBeenCalled();
  });

  it("rejects nested workspace/user selectors before a private context write", async () => {
    const response = await PUT(new NextRequest("http://localhost/api/saga/persona-context", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        selfDescription: "Jag bygger system.",
        workspaceId: "not-allowed",
        organizations: [{ name: "SAGA", user_id: "not-allowed" }],
      }),
    }));
    expect(response.status).toBe(422);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-robots-tag")).toBe("noindex");
    expect(mocks.replaceContext).not.toHaveBeenCalled();
  });

  it("rejects sensitive self-description without a fresh storage receipt before the repository runs", async () => {
    const response = await PUT(new NextRequest("http://localhost/api/saga/persona-context", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        political: { mode: "neutral" },
        religion: { mode: "not_specified" },
      }),
    }));
    expect(response.status).toBe(422);
    expect(mocks.replaceContext).not.toHaveBeenCalled();
  });

  it("calls deletion without a client scope and never serializes an unknown sensitive error", async () => {
    mocks.deleteContext.mockResolvedValue(true);
    const deleted = await DELETE();
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ deleted: true });
    expect(mocks.deleteContext).toHaveBeenCalledWith(actor);

    mocks.getContext.mockRejectedValue(new Error("https://private.example/?token=do-not-leak"));
    const failed = await GET();
    const body = await failed.json() as { error: string };
    expect(failed.status).toBe(500);
    expect(body.error).not.toContain("private.example");
    expect(body.error).not.toContain("token");
  });
});
