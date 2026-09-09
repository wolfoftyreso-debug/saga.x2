import { describe, expect, it } from "vitest";
import { apiAccessKeyCreateSchema, hasApiAccessScope } from "@/lib/domain/api-access";
import {
  createApiAccessTokenMaterial,
  hashApiAccessToken,
  parseApiAccessToken,
  readExternalApiToken,
} from "@/lib/services/api-access";

describe("externa API-nycklar", () => {
  it("skapar ett slumpmässigt plaintext-token men bara ett hashbart lagringsvärde", () => {
    const material = createApiAccessTokenMaterial();
    expect(material.plaintextKey).toMatch(/^pdb_live_[A-Za-z0-9_-]{12}_[A-Za-z0-9_-]{43}$/);
    expect(material.secretHash).toMatch(/^[a-f0-9]{64}$/);
    expect(material.secretHash).toBe(hashApiAccessToken(material.plaintextKey));
    expect(material.secretHash).not.toContain(material.plaintextKey);
    expect(parseApiAccessToken(material.plaintextKey)?.prefix).toBe(material.prefix);
  });

  it("validerar läsbehörigheter och standarden lämnar SSE avstängt", () => {
    const parsed = apiAccessKeyCreateSchema.parse({ name: "Min RSS-läsare" });
    expect(parsed.scopes).toEqual(["briefs:read", "feed:json", "feed:rss"]);
    expect(hasApiAccessScope(parsed.scopes, "feed:sse")).toBe(false);
    expect(apiAccessKeyCreateSchema.safeParse({ name: "X", scopes: ["feed:json", "feed:json"] }).success).toBe(false);
    expect(apiAccessKeyCreateSchema.safeParse({ name: "X", scopes: ["write:all"] }).success).toBe(false);
  });

  it("tar aldrig en query-token om länken inte uttryckligen tillåter det", () => {
    const request = new Request("https://brief.example/api/v1/feed?token=query-token", {
      headers: { "x-api-key": "header-token" },
    });
    expect(readExternalApiToken(request, false)).toBe("header-token");
    expect(readExternalApiToken(new Request("https://brief.example/rss?token=query-token"), false)).toBeNull();
    expect(readExternalApiToken(new Request("https://brief.example/rss?token=query-token"), true)).toBe("query-token");
  });
});
