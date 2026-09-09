import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { NextRequest, NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({
  neonConfigurationResponse: vi.fn<(message?: string) => NextResponse | null>(() => null),
  requireNeonActor: vi.fn(),
  neonWriteErrorResponse: vi.fn((error: unknown, fallback: string) => {
    const name = error instanceof Error ? error.name : "";
    const status = name === "StudioContentConflictError"
      ? 409
      : name === "StudioContentValidationError"
        ? 422
        : 500;
    return NextResponse.json({ error: error instanceof Error ? error.message : fallback }, { status });
  }),
  getStudioDraft: vi.fn(),
  deleteStudioDraft: vi.fn(),
  updateStudioDraft: vi.fn(),
  rescheduleStudioDraft: vi.fn(),
  getStudioWorkspaceTimezone: vi.fn(),
  getStudioContentCalendar: vi.fn(),
}));

vi.mock("@/lib/neon/http", () => ({
  neonConfigurationResponse: mocks.neonConfigurationResponse,
  requireNeonActor: mocks.requireNeonActor,
  neonWriteErrorResponse: mocks.neonWriteErrorResponse,
}));

vi.mock("@/lib/neon/studio-content-repository", () => ({
  getStudioDraft: mocks.getStudioDraft,
  deleteStudioDraft: mocks.deleteStudioDraft,
  updateStudioDraft: mocks.updateStudioDraft,
  rescheduleStudioDraft: mocks.rescheduleStudioDraft,
  getStudioWorkspaceTimezone: mocks.getStudioWorkspaceTimezone,
  getStudioContentCalendar: mocks.getStudioContentCalendar,
}));

import { GET as getCalendar } from "@/app/api/content/calendar/route";
import { GET as getDraft, PATCH as patchDraft } from "@/app/api/content/drafts/[draftId]/route";

const actor = {
  userId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  role: "owner" as const,
  email: "owner@example.test",
  displayName: "Owner",
};
const draftId = "33333333-3333-4333-8333-333333333333";
const context = { params: Promise.resolve({ draftId }) };

const calendarMove = {
  scheduledAt: "2099-07-15T07:30:00.000Z",
  scheduledLocalDate: "2099-07-15",
  scheduledLocalTime: "09:30",
  timezone: "Europe/Stockholm",
  expectedRevision: 7,
};

function patch(body: unknown) {
  return new NextRequest(`https://brief.example/api/content/drafts/${draftId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function validationError(message = "Felaktig schemaläggning") {
  const error = new Error(message);
  error.name = "StudioContentValidationError";
  return error;
}

function conflictError() {
  const error = new Error("Utkastet har ändrats av någon annan.");
  error.name = "StudioContentConflictError";
  return error;
}

afterEach(() => {
  mocks.neonConfigurationResponse.mockReset().mockReturnValue(null);
  mocks.requireNeonActor.mockReset();
  mocks.neonWriteErrorResponse.mockClear();
  mocks.getStudioDraft.mockReset();
  mocks.deleteStudioDraft.mockReset();
  mocks.updateStudioDraft.mockReset();
  mocks.rescheduleStudioDraft.mockReset();
  mocks.getStudioWorkspaceTimezone.mockReset();
  mocks.getStudioContentCalendar.mockReset();
});

describe("SAGA calendar route contract", () => {
  it("fails closed on missing Vercel/Neon configuration and has no Supabase route dependency", async () => {
    mocks.neonConfigurationResponse.mockReturnValueOnce(NextResponse.json({ code: "configuration_required" }, { status: 503 }));
    const calendar = await getCalendar(new NextRequest("https://brief.example/api/content/calendar"));
    expect(calendar.status).toBe(503);
    expect(mocks.getStudioWorkspaceTimezone).not.toHaveBeenCalled();
    expect(mocks.getStudioContentCalendar).not.toHaveBeenCalled();

    const calendarRouteSource = readFileSync(resolve(process.cwd(), "app/api/content/calendar/route.ts"), "utf8");
    const draftsRouteSource = readFileSync(resolve(process.cwd(), "app/api/content/drafts/route.ts"), "utf8");
    const draftRouteSource = readFileSync(resolve(process.cwd(), "app/api/content/drafts/[draftId]/route.ts"), "utf8");
    expect(`${calendarRouteSource}\n${draftsRouteSource}\n${draftRouteSource}`).not.toMatch(/supabase/i);
  });

  it("uses the signed workspace's planning timezone when the calendar request does not override it", async () => {
    mocks.requireNeonActor.mockResolvedValueOnce({ actor });
    mocks.getStudioWorkspaceTimezone.mockResolvedValueOnce("Europe/Stockholm");
    mocks.getStudioContentCalendar.mockResolvedValueOnce({
      from: "2099-07-13",
      to: "2099-07-19",
      timezone: "Europe/Stockholm",
      entries: [],
    });

    const response = await getCalendar(new NextRequest("https://brief.example/api/content/calendar?from=2099-07-13&to=2099-07-19"));

    expect(response.status).toBe(200);
    expect(mocks.getStudioWorkspaceTimezone).toHaveBeenCalledWith(actor);
    expect(mocks.getStudioContentCalendar).toHaveBeenCalledWith(actor, {
      from: "2099-07-13",
      to: "2099-07-19",
      timezone: "Europe/Stockholm",
    });
  });

  it("does not allow a caller-supplied workspace or an invalid timezone to reach the calendar read model", async () => {
    mocks.requireNeonActor.mockResolvedValue({ actor });

    const invalidTimezone = await getCalendar(new NextRequest("https://brief.example/api/content/calendar?timezone=not-a-real-zone"));
    expect(invalidTimezone.status).toBe(400);
    expect(mocks.getStudioContentCalendar).not.toHaveBeenCalled();
  });

  it("returns the exact actor-scoped draft behind a calendar entry", async () => {
    const storedDraft = {
      id: draftId,
      revision: 7,
      title: "System som ger människor tid tillbaka",
      status: "scheduled",
      scheduledAt: calendarMove.scheduledAt,
      scheduledLocalDate: calendarMove.scheduledLocalDate,
      scheduledLocalTime: calendarMove.scheduledLocalTime,
      timezone: calendarMove.timezone,
    };
    mocks.requireNeonActor.mockResolvedValueOnce({ actor });
    mocks.getStudioDraft.mockResolvedValueOnce(storedDraft);

    const response = await getDraft(new NextRequest(`https://brief.example/api/content/drafts/${draftId}`), context);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ draft: storedDraft });
    expect(mocks.getStudioDraft).toHaveBeenCalledWith(actor, draftId);
  });

  it("does not expose a calendar draft outside the signed workspace", async () => {
    mocks.requireNeonActor.mockResolvedValueOnce({ actor });
    mocks.getStudioDraft.mockResolvedValueOnce(null);

    const response = await getDraft(new NextRequest(`https://brief.example/api/content/drafts/${draftId}`), context);

    expect(response.status).toBe(404);
    expect(mocks.getStudioDraft).toHaveBeenCalledWith(actor, draftId);
  });

  it("routes an exact five-field drag/drop payload through the narrow revision-checked move", async () => {
    mocks.requireNeonActor.mockResolvedValueOnce({ actor });
    mocks.rescheduleStudioDraft.mockResolvedValueOnce({ id: draftId, revision: 8, status: "scheduled" });

    const response = await patchDraft(patch(calendarMove), context);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ draft: { id: draftId, revision: 8, status: "scheduled" } });
    expect(mocks.rescheduleStudioDraft).toHaveBeenCalledWith(actor, draftId, calendarMove);
    expect(mocks.updateStudioDraft).not.toHaveBeenCalled();
  });

  it("rejects an incomplete calendar move before it can update or publish anything", async () => {
    mocks.requireNeonActor.mockResolvedValueOnce({ actor });
    const { expectedRevision, ...incomplete } = calendarMove;
    void expectedRevision;

    const response = await patchDraft(patch(incomplete), context);

    expect(response.status).toBe(422);
    expect(mocks.rescheduleStudioDraft).not.toHaveBeenCalled();
    expect(mocks.updateStudioDraft).not.toHaveBeenCalled();
  });

  it("keeps a full scheduled editor document on the atomic editor path, preserving copy and revision", async () => {
    mocks.requireNeonActor.mockResolvedValueOnce({ actor });
    const editorDocument = {
      ...calendarMove,
      title: "Provkör BYD i Sätra",
      body: "Boka en lugn provkörning och jämför räckvidd med dina vardagsresor.",
      status: "scheduled",
      approvalRequired: false,
    };
    mocks.updateStudioDraft.mockResolvedValueOnce({ id: draftId, revision: 8, title: editorDocument.title, status: "scheduled" });

    const response = await patchDraft(patch(editorDocument), context);

    expect(response.status).toBe(200);
    expect(mocks.updateStudioDraft).toHaveBeenCalledWith(actor, draftId, expect.objectContaining(editorDocument));
    expect(mocks.rescheduleStudioDraft).not.toHaveBeenCalled();
  });

  it("returns 422 for a scheduled editor save without revision, rather than silently overwriting it", async () => {
    mocks.requireNeonActor.mockResolvedValueOnce({ actor });
    const { expectedRevision, ...unsafeEditorDocument } = {
      ...calendarMove,
      title: "Ändrar innehållet",
      body: "Den här ändringen måste skyddas av revisionen.",
      status: "scheduled",
    };
    void expectedRevision;
    mocks.updateStudioDraft.mockRejectedValueOnce(validationError("Ladda om utkastet innan du ändrar ett schemalagt inlägg."));

    const response = await patchDraft(patch(unsafeEditorDocument), context);

    expect(response.status).toBe(422);
    expect(mocks.updateStudioDraft).toHaveBeenCalledWith(actor, draftId, expect.objectContaining({ title: unsafeEditorDocument.title }));
  });

  it("returns 409 when a stale full-editor revision races another change", async () => {
    mocks.requireNeonActor.mockResolvedValueOnce({ actor });
    const editorDocument = {
      ...calendarMove,
      title: "Stale editor save",
      body: "Den ska inte skriva över en nyare kalenderflytt.",
      status: "scheduled",
    };
    mocks.updateStudioDraft.mockRejectedValueOnce(conflictError());

    const response = await patchDraft(patch(editorDocument), context);

    expect(response.status).toBe(409);
    expect(mocks.rescheduleStudioDraft).not.toHaveBeenCalled();
  });
});
