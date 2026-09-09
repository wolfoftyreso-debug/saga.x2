// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContentStudio } from "@/components/content-studio";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const id = "11111111-1111-4111-8111-111111111111";
const secondId = "22222222-2222-4222-8222-222222222222";
const detailPath = (draftId: string) => `/api/content/drafts/${draftId}`;
const savedDraft = {
  id, revision: 7, contentType: "social_post", channels: ["linkedin"], title: "Sparad referens utanför listan",
  headline: "Referensen", body: "Den sparade formuleringen", status: "draft", timezone: "Europe/Stockholm",
  approvalRequired: true, media: [], scheduledAt: null, scheduledLocalDate: null, scheduledLocalTime: null,
};
// The real list endpoint returns only 100 rows even when the workspace has
// more. The requested saved draft is the 101st record, not a deleted object.
const firstHundred = Array.from({ length: 100 }, (_, index) => ({ ...savedDraft, id: `listed-${index}`, title: `Planerat inlägg ${index}` }));
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
let root: Root | undefined;
let container: HTMLDivElement;

function deferred() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((accept) => { resolve = accept; });
  return { promise, resolve };
}

function mockFetch(detail: (path: string, init?: RequestInit) => Promise<Response>, listed = firstHundred) {
  const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path.startsWith("/api/content/drafts/")) return detail(path, init);
    if (path === "/api/content/drafts?include=media") return Promise.resolve(json({ drafts: listed }));
    return Promise.resolve(json({}));
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

async function render(draftId = id) {
  if (!root) {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  }
  await act(async () => root!.render(createElement(ContentStudio, { route: "content", contentId: draftId })));
}

async function click(label: string) {
  const button = Array.from(container.querySelectorAll("button")).find((entry) => entry.textContent?.includes(label));
  if (!button) throw new Error(`Missing button: ${label}`);
  await act(async () => button.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  container?.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("direct-linked saved drafts outside the bounded Studio list", () => {
  it("loads the 101st draft by ID, edits with its revision, saves and survives a fresh mount", async () => {
    const read = deferred();
    let persisted = { ...savedDraft };
    let firstRead = true;
    const fetch = mockFetch(async (_path, init) => {
      if (init?.method === "PATCH") {
        const patch = JSON.parse(String(init.body));
        expect(patch.expectedRevision).toBe(7);
        persisted = { ...persisted, ...patch, revision: 8 };
        return json({ draft: persisted });
      }
      if (firstRead) { firstRead = false; return read.promise; }
      return json({ draft: persisted });
    });
    await render();
    expect(container.textContent).toContain("Läser det sparade utkastet.");
    expect(container.textContent).not.toContain("hittades inte");
    expect(fetch).toHaveBeenCalledWith(detailPath(id), expect.objectContaining({ cache: "no-store", credentials: "same-origin", signal: expect.any(AbortSignal) }));
    await act(async () => read.resolve(json({ draft: persisted })));
    expect(container.textContent).toContain(savedDraft.title);
    await click("Redigera");
    const body = Array.from(container.querySelectorAll("textarea")).find((entry) => entry.value === savedDraft.body)!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(body, "Förfinad och sparad referens");
      body.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click("Spara utkast");
    expect(persisted.body).toBe("Förfinad och sparad referens");
    expect(container.textContent).toContain("Utkastet är sparat.");
    await act(async () => root!.unmount());
    root = undefined;
    container.remove();
    await render();
    expect(container.textContent).toContain("Förfinad och sparad referens");
    expect(fetch.mock.calls.filter(([path, init]) => path === detailPath(id) && !init?.method)).toHaveLength(2);
  });

  it("shows not-found only after the detail endpoint actually returns 404", async () => {
    const read = deferred();
    mockFetch(() => read.promise);
    await render();
    expect(container.textContent).not.toContain("hittades inte");
    await act(async () => read.resolve(json({ error: "Utkastet finns inte." }, 404)));
    expect(container.textContent).toContain("Utkastet hittades inte i din arbetsyta.");
    expect(container.textContent).not.toContain("finns inte längre");
  });

  it("keeps server failure distinct from deletion and permits a successful retry", async () => {
    const detail = vi.fn().mockResolvedValueOnce(json({ error: "Arbetsytan kunde inte nås." }, 503)).mockResolvedValueOnce(json({ draft: savedDraft }));
    mockFetch(detail);
    await render();
    expect(container.textContent).toContain("Arbetsytan kunde inte nås.");
    expect(container.textContent).not.toContain("hittades inte");
    await click("Försök igen");
    expect(container.textContent).toContain(savedDraft.title);
    expect(detail).toHaveBeenCalledTimes(2);
  });

  it("treats a network failure as retryable, not as a missing draft", async () => {
    mockFetch(() => Promise.reject(new TypeError("Network unavailable")));
    await render();
    expect(container.textContent).toContain("Utkastet kunde inte hämtas just nu.");
    expect(container.textContent).not.toContain("hittades inte");
  });

  it.each([{ draft: { ...savedDraft, id: secondId } }, { draft: null }])("rejects a successful response that does not identify the requested draft: %j", async (payload) => {
    mockFetch(() => Promise.resolve(json(payload)));
    await render();
    expect(container.textContent).toContain("Utkastet kunde inte hämtas just nu.");
    expect(container.textContent).not.toContain(savedDraft.title);
  });

  it.each([200, 404])("aborts a replaced selection and ignores its late %i response", async (lateStatus) => {
    const first = deferred();
    const second = deferred();
    let firstSignal: AbortSignal | null | undefined;
    mockFetch((path, init) => {
      if (path === detailPath(id)) { firstSignal = init?.signal; return first.promise; }
      return second.promise;
    });
    await render();
    expect(firstSignal?.aborted).toBe(false);
    await render(secondId);
    expect(firstSignal?.aborted).toBe(true);
    await act(async () => second.resolve(json({ draft: { ...savedDraft, id: secondId, title: "Det nya valet", body: "Texten för det nya valet" } })));
    await act(async () => first.resolve(json(lateStatus === 200 ? { draft: savedDraft } : { error: "Saknas" }, lateStatus)));
    expect(container.textContent).toContain("Det nya valet");
    expect(container.textContent).not.toContain(savedDraft.title);
    expect(container.textContent).not.toContain("hittades inte");
  });

  it("does not refetch an ID already included in the loaded list", async () => {
    const detail = vi.fn();
    mockFetch(detail, [savedDraft, ...firstHundred]);
    await render();
    expect(container.textContent).toContain(savedDraft.title);
    expect(detail).not.toHaveBeenCalled();
  });
});
