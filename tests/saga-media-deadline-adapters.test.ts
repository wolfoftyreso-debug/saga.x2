import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withExecutionDeadline } from "@/lib/server/execution-deadline";

const mocks = vi.hoisted(() => ({ generate:vi.fn(), put:vi.fn(), head:vi.fn(), del:vi.fn(), neon:vi.fn() }));
vi.mock("@/lib/vercel/ai-gateway", async (original) => ({
  ...await original<typeof import("@/lib/vercel/ai-gateway")>(),
  createAiGatewayClient:() => ({images:{generate:mocks.generate}}),
}));
vi.mock("@vercel/blob", () => ({put:mocks.put,head:mocks.head,del:mocks.del}));
vi.mock("@neondatabase/serverless", () => ({neon:mocks.neon}));
import { generateSagaPrivateMedia } from "@/lib/services/saga-media-generation";
import { createNeonSql } from "@/lib/neon/database";
import { createStudioBlobPath, getPrivateStudioBlobMetadata, uploadStudioBlob } from "@/lib/vercel/blob-media";

const scope = {workspaceId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",draftId:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"};
const runId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const pngBytes = new Uint8Array([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0]);
const input = {
  runId,scope,
  creativeBrief:{format:"display" as const,hook:"Mer tid för mänskligt arbete.",value:"En kontrollerad process förenklar dagen.",
    offer:{copy:"Ingen verifierad erbjudandetext.",terms:"",verification:{status:"unverified" as const,sourceReference:""}},
    callToAction:"Granska utkastet.",visualMetaphor:"day_to_evening" as const,customVisualDirection:""},
  output:{aspectRatio:"square" as const,altText:"En privat testbild.",label:"qa"},
};

function waitForAbort(signal:AbortSignal):Promise<never> {
  return new Promise((_,reject) => {
    signal.addEventListener("abort",() => reject(signal.reason),{once:true});
    if (signal.aborted) reject(signal.reason);
  });
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("BLOB_READ_WRITE_TOKEN","isolated-test-token");
  Object.values(mocks).forEach((mock) => mock.mockReset());
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe("real media adapters consume the shared execution signal", () => {
  it("gives the image SDK the actual signal, shortened timeout and zero hidden retries", async () => {
    let signal:AbortSignal | undefined;
    mocks.generate.mockImplementation((_body:unknown,options:{signal:AbortSignal;timeout:number;maxRetries:number}) => {
      signal=options.signal;
      expect(options.timeout).toBeLessThanOrEqual(100);
      expect(options.maxRetries).toBe(0);
      return waitForAbort(options.signal);
    });
    const pending = withExecutionDeadline(Date.now()+100, () => generateSagaPrivateMedia(input, {
      resolveConfiguration:() => ({model:"test-only"}),
      applyEditorialFinish:async (image) => image,
    }));
    const assertion = expect(pending).rejects.toMatchObject({name:"TimeoutError"});
    await vi.advanceTimersByTimeAsync(101);
    await assertion;
    expect(signal?.aborted).toBe(true);
    expect(mocks.put).not.toHaveBeenCalled();
  });

  it("cancels the actual private Blob PUT without starting a recovery HEAD", async () => {
    let signal:AbortSignal | undefined;
    mocks.put.mockImplementation((_path:unknown,_bytes:unknown,options:{abortSignal:AbortSignal}) => {
      signal=options.abortSignal;
      return waitForAbort(signal);
    });
    const pending = withExecutionDeadline(Date.now()+100, () => uploadStudioBlob({scope,bytes:pngBytes,fileName:"qa.png",contentType:"image/png",stableObjectId:runId}));
    const assertion = expect(pending).rejects.toMatchObject({name:"TimeoutError"});
    await vi.advanceTimersByTimeAsync(101);
    await assertion;
    expect(signal?.aborted).toBe(true);
    expect(mocks.head).not.toHaveBeenCalled();
    expect(mocks.del).not.toHaveBeenCalled();
  });

  it("cancels private Blob metadata reads with the same parent deadline", async () => {
    let signal:AbortSignal | undefined;
    mocks.head.mockImplementation((_path:unknown,options:{abortSignal:AbortSignal}) => {
      signal=options.abortSignal;
      return waitForAbort(signal);
    });
    const pathname=createStudioBlobPath(scope,"qa.png","image/png",runId);
    const pending=withExecutionDeadline(Date.now()+100, () => getPrivateStudioBlobMetadata({scope,pathname}));
    const assertion=expect(pending).rejects.toMatchObject({name:"TimeoutError"});
    await vi.advanceTimersByTimeAsync(101);
    await assertion;
    expect(signal?.aborted).toBe(true);
  });

  it("cancels Neon HTTP writes through fetchOptions, never a detached Promise.race", async () => {
    let signal:AbortSignal | undefined;
    mocks.neon.mockImplementation((_url:unknown,options:{fetchOptions:{signal:AbortSignal}}) => {
      signal=options.fetchOptions.signal;
      return {query:() => waitForAbort(signal!)};
    });
    const pending=withExecutionDeadline(Date.now()+100, () => createNeonSql("postgresql://isolated-test").query("select 1"));
    const assertion=expect(pending).rejects.toMatchObject({name:"TimeoutError"});
    await vi.advanceTimersByTimeAsync(101);
    await assertion;
    expect(signal?.aborted).toBe(true);
  });
});
