import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AppActor } from "@/lib/neon/auth-repository";
import type { NeonSql } from "@/lib/neon/database";
import {
  NewsletterAudienceAccessError,
  NewsletterConsentError,
  createStudioNewsletterContact,
  deleteStudioNewsletterAudience,
  listStudioNewsletterAudienceSummaries,
  listStudioNewsletterContacts,
  updateStudioNewsletterContact,
} from "@/lib/neon/newsletter-repository";

const workspaceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const userId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const audienceId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const contactId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const actor: AppActor = { userId, workspaceId, role: "owner", email: "owner@example.com", displayName: "Owner" };

function sqlWith(...results: unknown[]) {
  const query = vi.fn();
  for (const result of results) query.mockResolvedValueOnce(result);
  return { sql: { query } as unknown as NeonSql, query };
}

describe("Neon newsletter audiences", () => {
  it("ships workspace-scoped audiences, contacts and a database consent boundary", () => {
    const migration = readFileSync(resolve(process.cwd(), "db/migrations/202608230004_neon_newsletter_audiences.sql"), "utf8");

    expect(migration).toContain("create table if not exists newsletter_audiences");
    expect(migration).toContain("create table if not exists newsletter_contacts");
    expect(migration).toContain("foreign key (workspace_id, audience_id)");
    expect(migration).toContain("unique (workspace_id, audience_id, email)");
    expect(migration).toContain("check (status <> 'subscribed' or consented_at is not null)");
    expect(migration.toLowerCase()).not.toContain("supabase");
  });

  it("returns a non-PII audience summary scoped by the trusted workspace", async () => {
    const { sql, query } = sqlWith([{
      id: audienceId,
      name: "Kunder i Norden",
      active: true,
      contact_count: "5",
      subscribed_count: "3",
      unsubscribed_count: "1",
      suppressed_count: "1",
    }]);

    await expect(listStudioNewsletterAudienceSummaries(actor, sql)).resolves.toEqual([{
      audienceId,
      audienceName: "Kunder i Norden",
      audienceActive: true,
      contactCount: 5,
      subscribedCount: 3,
      unsubscribedCount: 1,
      suppressedCount: 1,
      queuedCount: 0,
      sendingCount: 0,
      deliveredCount: 0,
      failedCount: 0,
      unknownCount: 0,
    }]);

    const [statement, params] = query.mock.calls[0] ?? [];
    expect(statement).toContain("where audience.workspace_id = $1::uuid");
    expect(statement).not.toContain("contact.email");
    expect(params).toEqual([workspaceId]);
  });

  it("refuses a subscribed contact without documented consent before any database write", async () => {
    const { sql, query } = sqlWith();

    await expect(createStudioNewsletterContact(actor, {
      audienceId,
      email: "person@example.com",
      status: "subscribed",
      consentSource: "Manuell import",
      consentedAt: null,
      contactMetadata: {},
    }, sql)).rejects.toBeInstanceOf(NewsletterConsentError);

    expect(query).not.toHaveBeenCalled();
  });

  it("normalizes addresses, proves audience ownership, and writes only inside the actor workspace", async () => {
    const { sql, query } = sqlWith(
      [{ id: audienceId }],
      [{
        id: contactId,
        audience_id: audienceId,
        email: "person@example.com",
        display_name: "Person",
        status: "subscribed",
        consent_source: "Anmälan på webbplatsen",
        consented_at: "2026-08-23T10:00:00.000Z",
        unsubscribed_at: null,
        suppression_reason: null,
        contact_metadata: {},
        created_at: "2026-08-23T10:00:00.000Z",
        updated_at: "2026-08-23T10:00:00.000Z",
      }],
    );

    const contact = await createStudioNewsletterContact(actor, {
      audienceId,
      email: "Person@Example.COM",
      displayName: "Person",
      status: "subscribed",
      consentSource: "Anmälan på webbplatsen",
      consentedAt: "2026-08-23T10:00:00.000Z",
      contactMetadata: {},
    }, sql);

    expect(contact.email).toBe("person@example.com");
    const [ownershipStatement, ownershipParams] = query.mock.calls[0] ?? [];
    const [insertStatement, insertParams] = query.mock.calls[1] ?? [];
    expect(ownershipStatement).toContain("workspace_id = $1::uuid");
    expect(ownershipParams).toEqual([workspaceId, audienceId]);
    expect(insertStatement).toContain("insert into newsletter_contacts");
    expect(insertParams).toEqual(expect.arrayContaining([workspaceId, audienceId, "person@example.com"]));
  });

  it("authorizes an audience before reading its recipient details and parameterizes the status filter", async () => {
    const { sql, query } = sqlWith(
      [{ id: audienceId }],
      [{
        id: contactId,
        audience_id: audienceId,
        email: "person@example.com",
        display_name: null,
        status: "subscribed",
        consent_source: "manual",
        consented_at: "2026-08-23T10:00:00.000Z",
        unsubscribed_at: null,
        suppression_reason: null,
        contact_metadata: {},
        created_at: "2026-08-23T10:00:00.000Z",
        updated_at: "2026-08-23T10:00:00.000Z",
      }],
    );

    await expect(listStudioNewsletterContacts(actor, audienceId, { limit: 10, status: "subscribed" }, sql)).resolves.toMatchObject([
      { id: contactId, audienceId, email: "person@example.com", status: "subscribed" },
    ]);

    const [statement, params] = query.mock.calls[1] ?? [];
    expect(statement).toContain("workspace_id = $1::uuid");
    expect(statement).toContain("and status = $3");
    expect(params).toEqual([workspaceId, audienceId, "subscribed", 10]);
  });

  it("requires a fresh consent timestamp when a suppressed contact is reactivated", async () => {
    const { sql, query } = sqlWith([{
      id: contactId,
      audience_id: audienceId,
      email: "person@example.com",
      display_name: null,
      status: "unsubscribed",
      consent_source: "manual",
      consented_at: "2025-08-23T10:00:00.000Z",
      unsubscribed_at: "2026-08-01T10:00:00.000Z",
      suppression_reason: "Avprenumererad",
      contact_metadata: {},
      created_at: "2025-08-23T10:00:00.000Z",
      updated_at: "2026-08-01T10:00:00.000Z",
    }]);

    await expect(updateStudioNewsletterContact(actor, contactId, { status: "subscribed" }, sql)).rejects.toBeInstanceOf(NewsletterConsentError);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("clears an old opt-out when a fresh documented opt-in reactivates a contact", async () => {
    const existing = {
      id: contactId,
      audience_id: audienceId,
      email: "person@example.com",
      display_name: null,
      status: "unsubscribed",
      consent_source: "manual",
      consented_at: "2025-08-23T10:00:00.000Z",
      unsubscribed_at: "2026-08-01T10:00:00.000Z",
      suppression_reason: "Avprenumererad",
      contact_metadata: {},
      created_at: "2025-08-23T10:00:00.000Z",
      updated_at: "2026-08-01T10:00:00.000Z",
    };
    const { sql, query } = sqlWith([existing], [{
      ...existing,
      status: "subscribed",
      consented_at: "2026-08-23T11:00:00.000Z",
      unsubscribed_at: null,
      updated_at: "2026-08-23T11:00:00.000Z",
    }]);

    const contact = await updateStudioNewsletterContact(actor, contactId, {
      status: "subscribed",
      consentedAt: "2026-08-23T11:00:00.000Z",
    }, sql);

    expect(contact).toMatchObject({ status: "subscribed", consentedAt: "2026-08-23T11:00:00.000Z", unsubscribedAt: null });
    const [, params] = query.mock.calls[1] ?? [];
    expect(params?.[7]).toBeNull();
  });

  it("does not allow a viewer to mutate audience data", async () => {
    const viewer: AppActor = { ...actor, role: "viewer" };
    const { sql, query } = sqlWith();

    await expect(deleteStudioNewsletterAudience(viewer, audienceId, sql)).rejects.toBeInstanceOf(NewsletterAudienceAccessError);
    expect(query).not.toHaveBeenCalled();
  });
});
