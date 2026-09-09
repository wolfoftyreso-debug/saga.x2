import { describe, expect, it, vi } from "vitest";
import type { SagaAdobeAuthoringGenerationClaim } from "@/lib/domain/saga-adobe-authoring";
import {
  generationInputForSagaAdobeAuthoringClaim,
  runSagaAdobeAuthoringWorker,
  type SagaAdobeAuthoringWorkerDependencies,
} from "@/lib/neon/saga-adobe-authoring-worker";
import { assessGeneratedContentQuality } from "@/lib/services/saga-production-quality";

const actor = {
  userId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  role: "owner" as const,
  email: null,
  displayName: "Nils Systembyggare",
};

const claim: SagaAdobeAuthoringGenerationClaim = {
  commandId: "12121212-1212-4121-8121-121212121212",
  commandClaimToken: "13131313-1313-4131-8131-131313131313",
  jobId: "33333333-3333-4333-8333-333333333333",
  claimToken: "44444444-4444-4444-8444-444444444444",
  receiptId: "55555555-5555-4555-8555-555555555555",
  runId: "66666666-6666-4666-8666-666666666666",
  runRevision: 2,
  candidateId: "77777777-7777-4777-8777-777777777777",
  candidateOrdinal: 2,
  reference: {
    sourceDraftId: "88888888-8888-4888-8888-888888888888",
    sourceDraftRevision: 3,
    contentType: "social_post",
    channels: ["linkedin"],
    title: "System frigör tid",
    body: "När ett återkommande handgrepp blir ett system kan människor använda sin energi till omdöme relationer och skapande.",
    language: "sv",
    timezone: "Europe/Stockholm",
    capturedAt: "2026-08-26T12:00:00.000Z",
  },
  objective: "Förklara hur välbyggda system frigör mänsklig tid.",
  authorPrompt: "Låt texten vara ödmjuk och konkret.",
  includeAuthorName: true,
  authorName: "Nils Systembyggare",
  knowledge: [{
    entryId: "99999999-9999-4999-8999-999999999999",
    policyRevision: 1,
    knowledgeDate: "2026-08-26",
    topic: "AI och arbete",
    headline: "Automatisering flyttar fokus till omdöme",
    summary: "En kort, avgränsad sammanfattning utan rå källtext eller URL.",
    evidenceCount: 2,
    independentPublisherCount: 2,
    capturedAt: "2026-08-26T08:00:00.000Z",
  }],
};

const generated = {
  draft: {
    title: "System ska ge människor tillbaka sin tid",
    headline: "När det repetitiva blir ett system får omdömet mer plats",
    subject: "System som frigör tid",
    previewText: "En konkret reflektion om automatisering och mänskligt omdöme.",
    body: "System är inte ett mål i sig. De tar hand om upprepningar så att människor kan tänka bättre, bygga längre och vara mer närvarande i det som kräver omdöme. Börja med en återkommande uppgift och gör den synlig. Fråga sedan vad som kan få ett tydligt flöde, en kontroll och ett tryggt undantag. Då blir tekniken ett sätt att ge tid tillbaka, inte ännu en sak att bevaka.",
    callToAction: "Välj en uppgift du vill frigöra först och skriv ner dess första enkla steg.",
    hashtags: ["#system", "#automation"],
    imagePrompt: "Dokumentär arbetsmiljö med naturligt ljus och ett antecknat flöde på ett träbord, utan text eller logotyp.",
    altText: "Ett träbord med anteckningar som visar ett enkelt arbetsflöde.",
  },
  model: "gateway/test-model",
  responseId: "resp_test_123",
  inputTokens: 100,
  outputTokens: 150,
};

describe("SAGA Adobe authoring worker", () => {
  it("uses only server snapshots and creates a private candidate, never a Studio draft", async () => {
    const complete = vi.fn().mockResolvedValue({ candidateId: claim.candidateId, stale: false });
    const dependencies: SagaAdobeAuthoringWorkerDependencies = {
      claim: vi.fn().mockResolvedValue(claim),
      lens: vi.fn().mockResolvedValue(null),
      generate: vi.fn().mockResolvedValue(generated),
      assess: assessGeneratedContentQuality,
      complete,
      block: vi.fn(),
      fail: vi.fn(),
      finish: vi.fn().mockResolvedValue(true),
    };
    const result = await runSagaAdobeAuthoringWorker({
      actor,
      runId: claim.runId,
      receiptId: claim.receiptId,
      commandId: claim.commandId,
      commandClaimToken: claim.commandClaimToken,
      dependencies,
    });
    expect(result).toMatchObject({ candidatesReady: 1, studioDraftsCreated: 0, noPublication: true });
    expect(complete).toHaveBeenCalledWith(actor, expect.objectContaining({
      materialization: expect.objectContaining({
        model: "gateway/test-model",
        responseId: "resp_test_123",
        inputTokens: 100,
        outputTokens: 150,
      }),
    }));
  });

  it("processes one candidate per explicit continuation and never loops a ten-item series in one Vercel request", async () => {
    const secondClaim: SagaAdobeAuthoringGenerationClaim = {
      ...claim,
      jobId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      claimToken: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      candidateId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      candidateOrdinal: 3,
    };
    const claims = [claim, secondClaim];
    const complete = vi.fn().mockImplementation(async (_actor: typeof actor, input: { jobId: string }) => ({
      candidateId: input.jobId === claim.jobId ? claim.candidateId : secondClaim.candidateId,
      stale: false,
    }));
    const dependencies: SagaAdobeAuthoringWorkerDependencies = {
      claim: vi.fn().mockImplementation(async () => claims.shift() ?? null),
      lens: vi.fn().mockResolvedValue(null),
      generate: vi.fn().mockResolvedValue(generated),
      assess: assessGeneratedContentQuality,
      complete,
      block: vi.fn(),
      fail: vi.fn(),
      finish: vi.fn().mockResolvedValue(true),
    };

    const first = await runSagaAdobeAuthoringWorker({
      actor,
      runId: claim.runId,
      receiptId: claim.receiptId,
      commandId: claim.commandId,
      commandClaimToken: claim.commandClaimToken,
      dependencies,
    });
    const second = await runSagaAdobeAuthoringWorker({
      actor,
      runId: claim.runId,
      receiptId: claim.receiptId,
      commandId: claim.commandId,
      commandClaimToken: claim.commandClaimToken,
      dependencies,
    });

    expect(first).toMatchObject({ jobsClaimed: 1, candidatesReady: 1, studioDraftsCreated: 0, noPublication: true });
    expect(second).toMatchObject({ jobsClaimed: 1, candidatesReady: 1, studioDraftsCreated: 0, noPublication: true });
    expect(dependencies.claim).toHaveBeenCalledTimes(2);
    expect(dependencies.generate).toHaveBeenCalledTimes(2);
  });

  it("releases a claimed command when no job remains, so another explicit request is never stranded", async () => {
    const finish = vi.fn().mockResolvedValue(true);
    const dependencies: SagaAdobeAuthoringWorkerDependencies = {
      claim: vi.fn().mockResolvedValue(null),
      lens: vi.fn(),
      generate: vi.fn(),
      assess: assessGeneratedContentQuality,
      complete: vi.fn(),
      block: vi.fn(),
      fail: vi.fn(),
      finish,
    };

    const result = await runSagaAdobeAuthoringWorker({
      actor,
      runId: claim.runId,
      receiptId: claim.receiptId,
      commandId: claim.commandId,
      commandClaimToken: claim.commandClaimToken,
      dependencies,
    });

    expect(result).toMatchObject({ jobsClaimed: 0, studioDraftsCreated: 0, noPublication: true });
    expect(finish).toHaveBeenCalledWith(actor, {
      commandId: claim.commandId,
      commandClaimToken: claim.commandClaimToken,
    });
  });

  it("compacts server knowledge summaries into the prompt without any source URL or browser reference body", () => {
    const input = generationInputForSagaAdobeAuthoringClaim(claim);
    expect(input.brief).toContain("Automatisering flyttar fokus till omdöme");
    expect(input.brief).toContain("Nils Systembyggare");
    expect(input.brief).not.toContain("https://");
    expect(input.brief).toContain("Kontrollera sakuppgifter mänskligt");
    expect(input.brief).not.toContain("Verifierade dagliga insikter");
    expect(input.templateInstructions).toContain("privat textkandidat");
  });
});
