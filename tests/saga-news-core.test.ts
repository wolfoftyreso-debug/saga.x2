import { describe, expect, it, vi } from "vitest";
import { SagaNewsCoreError } from "@/lib/news-core/errors";
import { createSagaGdeltPacer, fetchSagaGdeltDocCandidates } from "@/lib/news-core/gdelt";
import { fetchSagaGuardianOpenPlatformCandidates } from "@/lib/news-core/guardian";
import { fetchSagaRssAtomCandidates, parseSagaRssAtomFeed, prepareSagaRssAtomSource } from "@/lib/news-core/rss-atom";
import {
  isUnsafeSagaNewsAddress,
  resolveSagaNewsPublicHost,
  validateSagaNewsOutboundUrl,
  type SagaNewsOutboundRequest,
} from "@/lib/news-core/safe-outbound";
import { toSagaNewsPersistenceInput } from "@/lib/news-core/types";

const SOURCE_ID = "11111111-1111-4111-8111-111111111111";
const FIXED_NOW = new Date("2026-08-24T09:00:00.000Z");

describe("SAGA News Core: outbound boundary", () => {
  it("accepterar ett ogenomskinligt UUID-källid men avvisar query, privata värdar och IP-adresser", async () => {
    const prepared = prepareSagaRssAtomSource({
      sourceId: SOURCE_ID,
      name: "Regeringen",
      feedUrl: "https://www.regeringen.se/press/rss.xml",
      allowedHosts: ["regeringen.se"],
    });
    expect(prepared.sourceId).toBe(SOURCE_ID);

    expect(() => prepareSagaRssAtomSource({
      sourceId: SOURCE_ID,
      name: "Fel",
      feedUrl: "https://regeringen.se/rss.xml?token=secret",
      allowedHosts: ["regeringen.se"],
    })).toThrow(SagaNewsCoreError);

    expect(() => validateSagaNewsOutboundUrl(new URL("https://127.0.0.1/feed.xml"), {
      allowedHosts: ["127.0.0.1"],
      acceptedContentTypes: ["application/xml"],
    })).toThrow(SagaNewsCoreError);
    expect(isUnsafeSagaNewsAddress("10.1.2.3")).toBe(true);
    expect(isUnsafeSagaNewsAddress("169.254.169.254")).toBe(true);
    expect(isUnsafeSagaNewsAddress("::1")).toBe(true);
    expect(isUnsafeSagaNewsAddress("8.8.8.8")).toBe(false);

    await expect(resolveSagaNewsPublicHost("feed.example", async () => [{ address: "10.0.0.9", family: 4 }]))
      .rejects.toMatchObject({ code: "outbound_dns" });
  });

  it("normaliserar RSS utan content:encoded, HTML eller querysträngar", async () => {
    const fetchText = vi.fn(async () => ({
      status: 200,
      contentType: "application/rss+xml; charset=utf-8",
      text: `<?xml version="1.0"?><rss><channel><item>
        <title>Elbilar &amp; &lt;framtid&gt;</title>
        <link>https://www.regeringen.se/nyheter/elbilar?utm_source=rss&amp;token=should-not-survive</link>
        <guid>https://example.invalid/private?token=never</guid>
        <pubDate>Sun, 24 Aug 2026 08:30:00 GMT</pubDate>
        <description><![CDATA[<p>En <strong>kort</strong> sammanfattning.</p>]]></description>
        <content:encoded xmlns:content="urn:content"><![CDATA[HELA ARTIKELKROPPEN SKA ALDRIG LÄSAS]]></content:encoded>
      </item></channel></rss>`,
    }));
    const result = await fetchSagaRssAtomCandidates({
      sourceId: SOURCE_ID,
      name: "Regeringen",
      feedUrl: "https://www.regeringen.se/press/rss.xml",
      allowedHosts: ["regeringen.se"],
      language: "sv",
    }, { fetchText, now: () => FIXED_NOW });

    expect(fetchText).toHaveBeenCalledWith(expect.objectContaining({
      url: expect.objectContaining({ hostname: "www.regeringen.se", search: "" }),
    }));
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      provider: "rss_atom",
      canonicalUrl: "https://www.regeringen.se/nyheter/elbilar",
      title: "Elbilar & <framtid>",
      summary: "En kort sammanfattning.",
      sourceDomain: "regeringen.se",
      language: "sv",
    });
    expect(JSON.stringify(result)).not.toContain("HELA ARTIKELKROPPEN");
    expect(JSON.stringify(result)).not.toContain("should-not-survive");
    expect(JSON.stringify(result)).not.toContain("private?token");
  });

  it("läser Atom-alternate-länkar och gör dem till queryfria kandidater", () => {
    const candidates = parseSagaRssAtomFeed(`<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
      <entry><id>opaque-guid</id><title>Ny laddstandard</title>
      <link rel="self" href="https://api.example.test/item" />
      <link rel="alternate" href="https://www.example.test/story?utm=feed" />
      <updated>2026-08-24T08:10:00Z</updated><summary>Fakta &amp; analys.</summary></entry>
    </feed>`, {
      sourceId: SOURCE_ID,
      sourceName: "Officiell källa",
      language: "en",
      kind: "official",
      maxItems: 10,
      fetchedAt: FIXED_NOW.toISOString(),
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ canonicalUrl: "https://www.example.test/story", summary: "Fakta & analys." });
  });
});

describe("SAGA News Core: provider connectors", () => {
  it("bygger en strikt GDELT ArticleList-begäran och returnerar metadata utan artikelbrödtext", async () => {
    const requests: SagaNewsOutboundRequest[] = [];
    const fetchText = async (request: SagaNewsOutboundRequest) => {
      requests.push(request);
      return {
      status: 200,
      contentType: "application/json",
      text: JSON.stringify({
        articles: [{
          url: "https://www.example-news.test/ev?utm_source=gdelt",
          title: "Kinesiska elbilar växer",
          seendate: "20260824T081500Z",
          domain: "example-news.test",
          language: "Swedish",
          sourcecountry: "Sweden",
        }],
      }),
      };
    };
    const pacer = createSagaGdeltPacer();
    const result = await fetchSagaGdeltDocCandidates({
      sourceId: SOURCE_ID,
      query: '"electric vehicle" OR elbil',
      timespan: "1week",
      maxRecords: 5,
    }, { fetchText, now: () => FIXED_NOW, pacer });

    const request = requests[0];
    if (!request) throw new Error("GDELT-förfrågan saknas.");
    expect(request.url.hostname).toBe("api.gdeltproject.org");
    expect(request.url.searchParams.get("mode")).toBe("artlist");
    expect(request.url.searchParams.get("format")).toBe("json");
    expect(request.url.searchParams.get("maxrecords")).toBe("5");
    expect(result.candidates[0]).toMatchObject({
      provider: "gdelt_doc_2",
      canonicalUrl: "https://www.example-news.test/ev",
      summary: null,
      publishedAt: "2026-08-24T08:15:00.000Z",
      sourceDomain: "example-news.test",
    });
    expect(JSON.stringify(result)).not.toContain("utm_source");
    expect(JSON.stringify(result)).not.toContain("article body");
    try {
      pacer.claim(FIXED_NOW.getTime() + 1);
      throw new Error("GDELT-pacern skulle ha avvisat en omedelbar andra förfrågan.");
    } catch (error) {
      expect(error).toMatchObject({ code: "rate_limited" });
    }
  });

  it("håller Guardian-nyckeln helt utanför kandidatresultatet och hämtar endast metadata", async () => {
    const requests: SagaNewsOutboundRequest[] = [];
    const fetchText = async (request: SagaNewsOutboundRequest) => {
      requests.push(request);
      return {
      status: 200,
      contentType: "application/json; charset=utf-8",
      text: JSON.stringify({
        response: {
          status: "ok",
          results: [{
            id: "business/2026/aug/24/electric-cars",
            type: "article",
            sectionId: "business",
            sectionName: "Business",
            webPublicationDate: "2026-08-24T08:20:00Z",
            webTitle: "Electric cars in focus",
            webUrl: "https://www.theguardian.com/business/2026/aug/24/electric-cars?CMP=share",
            body: "This field must never be requested or returned.",
          }],
        },
      }),
      };
    };
    const result = await fetchSagaGuardianOpenPlatformCandidates({
      sourceId: SOURCE_ID,
      query: "electric cars",
      section: "business",
    }, { fetchText, apiKey: "server-only-guardian-key", now: () => FIXED_NOW });

    const request = requests[0];
    if (!request) throw new Error("Guardian-förfrågan saknas.");
    expect(request.url.hostname).toBe("content.guardianapis.com");
    expect(request.url.searchParams.get("api-key")).toBe("server-only-guardian-key");
    expect(request.url.searchParams.get("show-fields")).toBeNull();
    expect(result.candidates[0]).toMatchObject({
      provider: "guardian_open_platform",
      canonicalUrl: "https://www.theguardian.com/business/2026/aug/24/electric-cars",
      summary: null,
      sourceDomain: "theguardian.com",
    });
    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain("server-only-guardian-key");
    expect(serialised).not.toContain("This field must never");

    expect(toSagaNewsPersistenceInput(result.candidates[0])).toEqual(expect.objectContaining({
      sourceId: SOURCE_ID,
      provider: "guardian_open_platform",
      summary: null,
      canonicalUrl: "https://www.theguardian.com/business/2026/aug/24/electric-cars",
    }));
  });
});
