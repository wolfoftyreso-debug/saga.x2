import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const adapters = vi.hoisted(() => ({ neon: vi.fn(), parse: vi.fn(), lookup: vi.fn(), request: vi.fn() }));
vi.mock("@neondatabase/serverless", () => ({ neon: adapters.neon }));
vi.mock("@/lib/openai/client", () => ({
  getOpenAIClient: () => ({ responses: { parse: adapters.parse } }),
  getOpenAIModel: () => "diagnostic-model",
  MissingOpenAIConfigurationError: class extends Error {},
}));
vi.mock("node:dns/promises", () => ({ lookup: adapters.lookup }));
vi.mock("node:https", () => ({ request: adapters.request }));

import { executionAbortSignal, executionTimeRemainingMs, withExecutionDeadline } from "@/lib/server/execution-deadline";
import { createNeonSql } from "@/lib/neon/database";
import { generateContentDraft } from "@/lib/services/content-generation";
import { fetchSagaNewsText } from "@/lib/news-core/safe-outbound";

beforeEach(() => { vi.resetAllMocks(); vi.useFakeTimers(); });
afterEach(() => vi.useRealTimers());

const newsRequest = {
  url: new URL("https://news.example.com/feed"),
  policy: { allowedHosts: ["news.example.com"], acceptedContentTypes: ["application/rss+xml"] },
};

describe("cron deadline reaches actual network adapter options", () => {
  it("passes the deadline signal to Neon and cancels the pending HTTP query", async () => {
    let signal: AbortSignal;
    adapters.neon.mockImplementation((_url, options) => {
      signal = options.fetchOptions.signal;
      return { query: () => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })) };
    });
    const pending = withExecutionDeadline(Date.now() + 1_000, async () => {
      const sql = createNeonSql("postgresql://unused:unused@ep-example.neon.tech/neondb");
      await sql.query("select 1");
    });
    const rejected = expect(pending).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(1_000);
    await rejected;
    expect(signal!.aborted).toBe(true);
    expect(executionAbortSignal()).toBeUndefined();
  });

  it("cancels AI early and leaves the owning worker signal usable for a failure receipt", async () => {
    let generationSignal: AbortSignal;
    adapters.parse.mockImplementation((_input, options) => {
      generationSignal = options.signal;
      expect(options.timeout).toBe(2_000);
      return new Promise((_resolve, reject) => generationSignal.addEventListener("abort", () => reject(generationSignal.reason), { once: true }));
    });
    const pending = withExecutionDeadline(Date.now() + 5_000, async () => {
      await expect(generateContentDraft({ contentType: "social_post", channels: ["linkedin"], topic: "Automatisera återkommande arbete" } as Parameters<typeof generateContentDraft>[0])).rejects.toMatchObject({ status: 502 });
      expect(generationSignal!.aborted).toBe(true);
      expect(executionAbortSignal()?.aborted).toBe(false);
      expect(executionTimeRemainingMs()).toBe(3_000);
    });
    await vi.advanceTimersByTimeAsync(2_000);
    await pending;
  });

  it("cancels DNS waiting and never opens HTTPS when DNS eventually returns late", async () => {
    let resolveDns: (value: Array<{ address: string; family: number }>) => void;
    adapters.lookup.mockImplementation(() => new Promise((resolve) => { resolveDns = resolve; }));
    const pending = withExecutionDeadline(Date.now() + 5_000, () => fetchSagaNewsText(newsRequest));
    const rejected = expect(pending).rejects.toBeInstanceOf(Error);
    await vi.advanceTimersByTimeAsync(3_000);
    await rejected;
    resolveDns!([{ address: "8.8.8.8", family: 4 }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(adapters.request).not.toHaveBeenCalled();
  });

  it("supplies the deadline signal to pinned HTTPS and ends the waiting request on abort", async () => {
    adapters.lookup.mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
    let socketSignal: AbortSignal;
    adapters.request.mockImplementation((options) => {
      socketSignal = options.signal;
      const req = Object.assign(new EventEmitter(), { setTimeout: vi.fn(), end: vi.fn(), destroy: vi.fn() });
      socketSignal.addEventListener("abort", () => req.emit("error", socketSignal.reason), { once: true });
      return req;
    });
    const pending = withExecutionDeadline(Date.now() + 5_000, () => fetchSagaNewsText(newsRequest));
    const rejected = expect(pending).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(3_000);
    await rejected;
    expect(socketSignal!.aborted).toBe(true);
  });

  it("cannot extend a parent deadline and isolates concurrent invocation signals", async () => {
    let firstSignal: AbortSignal;
    let secondSignal: AbortSignal;
    const first = withExecutionDeadline(Date.now() + 1_000, () => withExecutionDeadline(Date.now() + 10_000, () => {
      firstSignal = executionAbortSignal()!;
      return new Promise((_resolve, reject) => firstSignal.addEventListener("abort", () => reject(firstSignal.reason), { once: true }));
    }));
    const rejected = expect(first).rejects.toMatchObject({ name: "TimeoutError" });
    const second = withExecutionDeadline(Date.now() + 5_000, async () => {
      secondSignal = executionAbortSignal()!;
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      expect(secondSignal.aborted).toBe(false);
    });
    await vi.advanceTimersByTimeAsync(2_000);
    await rejected;
    await second;
    expect(firstSignal!).not.toBe(secondSignal!);
  });
});
