// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SagaContentCalendar } from "@/components/saga-content-calendar";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root | undefined;
let container: HTMLDivElement;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  container?.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function mount() {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-09T08:00:00.000Z"));
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ width: 1400 } as DOMRect);
  const entries = [
    { id: "draft:a", draftId: "11111111-1111-4111-8111-111111111111", title: "Inlägg A", localTime: "09:00" },
    { id: "draft:b", draftId: "22222222-2222-4222-8222-222222222222", title: "Inlägg B", localTime: "14:00" },
  ].map((entry) => ({
    ...entry, kind: "draft", status: "draft", channels: ["linkedin"],
    startsAt: `2026-09-09T${entry.localTime}:00.000Z`, localDate: "2026-09-09",
    scheduledLocalDate: "2026-09-09", scheduledLocalTime: entry.localTime,
    timezone: "UTC", editable: true, revision: 7,
  }));
  let finishSave!: (response: Response) => void;
  let patchCount = 0;
  const deferredSave = new Promise<Response>((resolve) => { finishSave = resolve; });
  const requests = vi.fn((url: string, init?: RequestInit) => {
    if (init?.method === "PATCH") {
      patchCount += 1;
      return patchCount === 1 ? deferredSave : Promise.resolve(Response.json({ draft: { revision: 8 } }));
    }
    if (url.startsWith("/api/content/calendar?")) {
      return Promise.resolve(Response.json({ calendar: { timezone: "UTC", entries } }));
    }
    if (url === "/api/content/drafts?limit=250&include=media") {
      return Promise.resolve(Response.json({ drafts: [] }));
    }
    throw new Error(`Unexpected mocked request: ${url}`);
  });
  vi.stubGlobal("fetch", requests);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(createElement(SagaContentCalendar)));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  return { requests, finishSave };
}

function button(text: string) {
  const result = Array.from(container.querySelectorAll("button")).find((item) => item.textContent?.includes(text));
  if (!result) throw new Error(`Missing button: ${text}`);
  return result;
}

function scheduleTime() { return container.querySelector<HTMLInputElement>('input[type="time"]')!; }
async function click(text: string) { await act(async () => button(text).click()); }

describe("mounted calendar delayed schedule responses", () => {
  it("never copies a saved post's time into another selected post", async () => {
    const { requests, finishSave } = await mount();
    await click("Inlägg A");
    await click("+ 30 min");
    await click("Spara tid");
    expect(requests.mock.calls.find(([, init]) => init?.method === "PATCH")?.[1]?.body).toContain('"scheduledLocalTime":"09:30"');
    await click("Inlägg B");
    expect(scheduleTime().value).toBe("14:00");
    expect(button("Väntar på pågående sparning").disabled).toBe(true);
    expect(container.textContent).toContain("En annan posts tid sparas");
    // Even a direct form submit must not start B while A is in flight.
    await act(async () => {
      container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(requests.mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(1);
    await act(async () => { finishSave(Response.json({ draft: { revision: 8 } })); });
    expect(scheduleTime().value).toBe("14:00");
    await click("Spara tid");
    const patches = requests.mock.calls.filter(([, init]) => init?.method === "PATCH");
    expect(patches[1]?.[0]).toBe("/api/content/drafts/22222222-2222-4222-8222-222222222222");
    expect(JSON.parse(String(patches[1]?.[1]?.body))).toMatchObject({ scheduledLocalTime: "14:00", expectedRevision: 7 });
  });

  it.each([false, true])("preserves newer unsaved edits even after switching away and back: %s", async (switchBack) => {
    const { finishSave } = await mount();
    await click("Inlägg A");
    await click("+ 30 min");
    await click("Spara tid");
    if (switchBack) {
      await click("Inlägg B");
      await click("Inlägg A");
      await click("+ 30 min");
    }
    await click("+ 30 min");
    expect(scheduleTime().value).toBe("10:00");
    await act(async () => { finishSave(Response.json({ draft: { revision: 8 } })); });
    expect(scheduleTime().value).toBe("10:00");
    expect(container.textContent).toContain("kl. 09:30 är sparad");
  });

  it.each([409, 500])("preserves the other post's fields and releases the save gate after HTTP %s", async (status) => {
    const { finishSave } = await mount();
    await click("Inlägg A");
    await click("Spara tid");
    await click("Inlägg B");
    await click("+ 30 min");
    await act(async () => { finishSave(Response.json({ message: "Utkastet kunde inte sparas" }, { status })); });
    expect(scheduleTime().value).toBe("14:30");
    expect(button("Spara tid").disabled).toBe(false);
    expect(container.querySelector("#calendar-inspector")?.textContent).not.toContain("Utkastet kunde inte sparas");
  });
});
