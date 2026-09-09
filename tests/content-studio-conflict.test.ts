// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContentEditor, DraftRevisionConflictError, studioDraftSchedulePatch, studioBrandEndpoint } from "@/components/content-studio";
import { hasDraftEdits, mergeDraftConflict } from "@/components/content-studio-conflict";
import type { StudioDraftView } from "@/components/content-studio-adapter";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const base: StudioDraftView = {
  id: "11111111-1111-4111-8111-111111111111", revision: 7,
  contentType: "social_post", channels: ["linkedin"], title: "Titel", headline: "Rubrik", body: "Originaltext",
  subject: "", cta: "", excerpt: "", hashtags: "", generationPrompt: "Var konkret", imagePrompt: "Foto",
  status: "draft", timezone: "Europe/Stockholm", scheduledAt: "2026-09-09T07:00:00.000Z",
  scheduledLocalDate: "2026-09-09", scheduledLocalTime: "09:00", approvalRequired: true,
  media: [], templateId: null, automationRuleId: null, newsletterAudienceId: null,
  createdAt: "2026-09-08T08:00:00.000Z", updatedAt: "2026-09-08T08:00:00.000Z",
};
const moved: StudioDraftView = { ...base, revision: 8, scheduledAt: "2026-09-09T11:00:00.000Z", scheduledLocalTime: "13:00" };
let root: Root | undefined;
let container: HTMLDivElement;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  container?.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function mount(onSave: (draft: StudioDraftView) => Promise<StudioDraftView>, initialDraft = base) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(createElement(ContentEditor, {
    initialDraft, templates: [], audiences: [], onSave,
    onGenerate: async () => ({}), onUploadMedia: vi.fn(), onAdaptMedia: vi.fn(), onRemoveMedia: vi.fn(), onCancel: vi.fn(),
  })));
}
function button(text: string) {
  const found = Array.from(container.querySelectorAll("button")).find((item) => item.textContent?.includes(text));
  if (!found) throw new Error(`Missing button: ${text}`);
  return found;
}
function textField() { return container.querySelector<HTMLTextAreaElement>('textarea[rows="15"]')!; }
async function changeText(value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textField(), value);
    textField().dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function click(element: HTMLElement) { await act(async () => element.click()); }

describe("draft conflict three-way merge", () => {
  it("uses the draft timezone, not the device timezone, and rejects nonexistent local DST times", () => {
    expect(studioDraftSchedulePatch("2026-09-09T09:00", "Europe/Stockholm").scheduledAt).toBe("2026-09-09T07:00:00.000Z");
    expect(studioDraftSchedulePatch("2026-09-09T09:00", "America/New_York").scheduledAt).toBe("2026-09-09T13:00:00.000Z");
    expect(() => studioDraftSchedulePatch("2027-03-28T02:30", "Europe/Stockholm")).toThrow();
    expect(studioDraftSchedulePatch("", "Europe/Stockholm")).toEqual({ scheduledAt: null, scheduledLocalDate: null, scheduledLocalTime: null });
  });
  it("preserves local text and the concurrently moved calendar time without mutating any input", () => {
    const local = { ...base, body: "Min nya text" };
    const result = mergeDraftConflict(base, local, moved);
    expect(result.unresolved).toEqual([]);
    expect(result.draft).toMatchObject({ body: local.body, revision: 8, scheduledLocalTime: "13:00", scheduledAt: moved.scheduledAt });
    expect(local.revision).toBe(7);
    expect(moved.body).toBe(base.body);
    expect(hasDraftEdits(moved, result.draft)).toBe(true);
  });

  it("requires explicit resolution of diverged text but accepts identical edits", () => {
    const local = { ...base, body: "Min text" };
    const server = { ...moved, body: "Annan text" };
    expect(mergeDraftConflict(base, local, server).unresolved).toEqual(["body"]);
    expect(mergeDraftConflict(base, local, server, { body: "local" }).draft.body).toBe(local.body);
    expect(mergeDraftConflict(base, local, server, { body: "server" }).draft.body).toBe(server.body);
    expect(mergeDraftConflict(base, local, { ...server, body: local.body }).conflicts).toEqual([]);
  });

  it("keeps local date/time/timezone atomic and preserves server-owned restrictions and media", () => {
    const local = { ...base, timezone: "America/New_York", approvalRequired: false, privateBrief: false };
    const server = { ...moved, privateBrief: true, deliveryLocked: true, media: [{ id: "media", url: "/private", alt: "Ny bild", state: "ready" as const, kind: "image" as const }] };
    const pending = mergeDraftConflict(base, local, server);
    expect(pending.unresolved).toEqual(["schedule"]);
    const result = mergeDraftConflict(base, local, server, { schedule: "server" }).draft;
    expect(result).toMatchObject({ timezone: moved.timezone, scheduledAt: moved.scheduledAt, scheduledLocalTime: "13:00", privateBrief: true, deliveryLocked: true, media: server.media });
  });

  it("rejects different draft identities and unverified or non-newer server revisions", () => {
    for (const server of [{ ...moved, id: "other" }, { ...moved, revision: null }, { ...moved, revision: 7 }]) {
      expect(() => mergeDraftConflict(base, base, server)).toThrow("kunde inte verifieras");
    }
  });
});

describe("mounted editor conflict handling", () => {
  it("lets the manual new-draft flow select a brand and carries it to draft and AI endpoints", async () => {
    const first = "22222222-2222-4222-8222-222222222222";
    const second = "33333333-3333-4333-8333-333333333333";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ onboardings: [
      { brandProfileId: first, brandName: "Brand A", brandActive: true, completionState: "completed" },
      { brandProfileId: second, brandName: "Brand B", brandActive: true, completionState: "completed" },
    ] }), { status: 200 })));
    const save = vi.fn(async (draft: StudioDraftView) => ({ ...draft, id: base.id, revision: 1 }));
    await mount(save, { ...base, id: "local-new", revision: null });
    expect(button("Spara utkast").disabled).toBe(true);
    const select = container.querySelector<HTMLSelectElement>('select[aria-label="Varumärke för utkastet"]')!;
    expect(select.options).toHaveLength(3);
    await act(async () => { select.value = second; select.dispatchEvent(new Event("change", { bubbles: true })); });
    await click(button("Spara utkast"));
    expect(save.mock.calls[0]?.[0].brandProfileId).toBe(second);
    expect(studioBrandEndpoint("/api/content/drafts", second)).toBe(`/api/content/drafts?brandProfileId=${second}`);
    expect(studioBrandEndpoint("/api/content/generate", second)).toBe(`/api/content/generate?brandProfileId=${second}`);
  });

  it("does not unlock manual creation for unfinished onboarding", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ onboardings: [
      { brandProfileId: "22222222-2222-4222-8222-222222222222", brandName: "Inte klar", brandActive: true, completionState: "in_progress" },
    ] }), { status: 200 })));
    const save = vi.fn();
    await mount(save, { ...base, id: "local-new", revision: null });
    expect(button("Spara utkast").disabled).toBe(true);
    expect(container.textContent).toContain("Slutför varumärkets onboarding");
    expect(save).not.toHaveBeenCalled();
  });

  it("keeps entered text, explicitly combines with remote schedule, then saves the new revision", async () => {
    const save = vi.fn<(draft: StudioDraftView) => Promise<StudioDraftView>>()
      .mockRejectedValueOnce(new DraftRevisionConflictError(moved))
      .mockImplementationOnce(async (draft) => ({ ...draft, revision: 9 }));
    await mount(save);
    await changeText("Min osparade formulering");
    await click(button("Spara utkast"));
    expect(textField().value).toBe("Min osparade formulering");
    expect(button("Spara utkast").disabled).toBe(true);
    expect(document.activeElement?.id).toBe("draft-conflict-title");
    await click(button("Använd sammanfogad version"));
    expect(save).toHaveBeenCalledTimes(1);
    expect(textField().value).toBe("Min osparade formulering");
    expect(container.textContent).toContain("Återställningskopia");
    await click(button("Spara utkast"));
    expect(save.mock.calls[1]?.[0]).toMatchObject({ body: "Min osparade formulering", revision: 8, scheduledLocalTime: "13:00" });
  });

  it("does not allow a conflicting field to be silently overwritten and keeps a recoverable copy", async () => {
    const save = vi.fn().mockRejectedValue(new DraftRevisionConflictError({ ...moved, body: "Serverns text" }));
    await mount(save);
    await changeText("Min text");
    await click(button("Spara utkast"));
    expect(button("Använd sammanfogad version").disabled).toBe(true);
    const serverChoice = container.querySelectorAll<HTMLInputElement>('input[name="conflict-body"]')[1]!;
    await click(serverChoice);
    await click(button("Använd sammanfogad version"));
    expect(textField().value).toBe("Serverns text");
    await click(button("Återställ min tidigare redigering"));
    expect(textField().value).toBe("Min text");
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("keeps the local text editable when the newest server version cannot be fetched", async () => {
    await mount(vi.fn().mockRejectedValue(new DraftRevisionConflictError(null)));
    await changeText("Behåll mig");
    await click(button("Spara utkast"));
    expect(textField().value).toBe("Behåll mig");
    expect(button("Spara utkast").disabled).toBe(false);
    expect(container.textContent).toContain("senaste versionen kunde inte hämtas");
  });

  it("blocks overlapping edits and repeated saves while the first write is pending", async () => {
    let finish!: (value: StudioDraftView) => void;
    const save = vi.fn(() => new Promise<StudioDraftView>((resolve) => { finish = resolve; }));
    await mount(save);
    await changeText("Under sparning");
    await click(button("Spara utkast"));
    expect(textField().matches(":disabled")).toBe(true);
    await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(save).toHaveBeenCalledTimes(1);
    await act(async () => finish({ ...base, body: "Under sparning", revision: 8 }));
    expect(textField().value).toBe("Under sparning");
  });

  it("preserves edits through repeated conflicts and only offers the current server revision for retry", async () => {
    const secondMove = { ...moved, revision: 9, scheduledLocalTime: "14:00", scheduledAt: "2026-09-09T12:00:00.000Z" };
    const save = vi.fn().mockRejectedValueOnce(new DraftRevisionConflictError(moved))
      .mockRejectedValueOnce(new DraftRevisionConflictError(secondMove))
      .mockImplementationOnce(async (draft: StudioDraftView) => ({ ...draft, revision: 10 }));
    await mount(save);
    await changeText("Text från första fliken");
    await click(button("Spara utkast"));
    await click(button("Använd sammanfogad version"));
    await click(button("Spara utkast"));
    expect(textField().value).toBe("Text från första fliken");
    await click(button("Använd sammanfogad version"));
    await click(button("Spara utkast"));
    expect(save.mock.calls[2]?.[0]).toMatchObject({ revision: 9, body: "Text från första fliken", scheduledLocalTime: "14:00" });
  });

  it("keeps a local recovery copy but cannot overwrite a concurrently locked private draft", async () => {
    const locked = { ...moved, quarterlyPrivateReview: true, status: "approved" as const };
    const save = vi.fn().mockRejectedValue(new DraftRevisionConflictError(locked));
    await mount(save);
    await changeText("Min text före beslutet");
    await click(button("Spara utkast"));
    await click(button("Använd sammanfogad version"));
    expect(textField().value).toBe("Min text före beslutet");
    expect(button("Spara utkast").disabled).toBe(true);
    expect(container.textContent).toContain("låsts av ett beslut");
    expect(container.textContent).toContain("Återställningskopia");
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("asks before sidebar client navigation and preserves the edit when leaving is cancelled", async () => {
    await mount(vi.fn());
    await changeText("Osparat inför menybyte");
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const sidebar = document.createElement("a");
    sidebar.href = "/studio/calendar";
    document.body.append(sidebar);
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    await act(async () => sidebar.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(textField().value).toBe("Osparat inför menybyte");
    sidebar.remove();
  });
});
