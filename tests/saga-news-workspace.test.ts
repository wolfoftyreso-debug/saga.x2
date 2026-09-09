import { describe, expect, it } from "vitest";
import { sagaNewsSourceInput, type SagaNewsSourceForm } from "@/components/saga-news-workspace";
import { sagaNewsSourceInputSchema } from "@/lib/domain/saga-news-core";

const base: SagaNewsSourceForm = {
  id: null,
  name: "Svensk elbilsbevakning",
  slug: "svensk-elbilsbevakning",
  connectorKey: "rss_atom",
  endpointUrl: "https://example.se/feed.xml",
  topics: "Kinesiska elbilar\nPrisvärda elbilar",
  publisherAllowlist: "di.se\nsvd.se",
  minimumIntervalMinutes: 60,
  trustLevel: 4,
  active: true,
};

describe("SAGA News workspace source form", () => {
  it("maps a public GDELT choice to the server-owned endpoint rather than a caller URL", () => {
    const input = sagaNewsSourceInput({ ...base, connectorKey: "gdelt_doc_2", endpointUrl: "https://untrusted.example/anything" });
    expect(input).toMatchObject({
      sourceKind: "public_api",
      connectorKey: "gdelt_doc_2",
      endpointUrl: "https://api.gdeltproject.org/api/v2/doc/doc",
      allowlistMode: "strict",
      publisherAllowlist: ["di.se", "svd.se"],
    });
    expect(() => sagaNewsSourceInputSchema.parse(input)).not.toThrow();
  });

  it("keeps RSS address separate while requiring an explicitly approved publisher set", () => {
    const input = sagaNewsSourceInput(base);
    expect(input.endpointUrl).toBe("https://example.se/feed.xml");
    expect(input.topics).toEqual(["kinesiska elbilar", "prisvärda elbilar"]);
    expect(() => sagaNewsSourceInputSchema.parse(input)).not.toThrow();
  });
});
