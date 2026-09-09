import "server-only";

import { createHash, randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import type { VercelIdentity } from "@/lib/auth/vercel-oauth";
import { createNeonSql, type NeonSql } from "@/lib/neon/database";

const SESSION_COOKIE = "brief_session";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 14;

export type AppActor = {
  userId: string;
  workspaceId: string;
  /** Server-verified request context; never loaded from a browser cookie or body. */
  brandProfileId?: string;
  role: "owner" | "editor" | "viewer";
  email: string | null;
  displayName: string | null;
};

type UserRow = {
  id: string;
  email: string | null;
  display_name: string | null;
};

type MembershipRow = {
  workspace_id: string;
  role: "owner" | "editor" | "viewer";
};

type SessionRow = {
  user_id: string;
  workspace_id: string;
  role: "owner" | "editor" | "viewer";
  email: string | null;
  display_name: string | null;
};

function sessionHash(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

function workspaceSlug(identity: VercelIdentity): string {
  // A deterministic slug makes concurrent first sign-ins converge without
  // trusting user input. It exposes neither the e-mail nor the Vercel subject.
  return `workspace-${createHash("sha256").update(identity.subject).digest("hex").slice(0, 20)}`;
}

function workspaceName(identity: VercelIdentity): string {
  const first = identity.name?.trim() || identity.username?.trim();
  return first ? `${first.slice(0, 120)}s arbetsyta` : "Privat arbetsyta";
}

function asRole(value: string): "owner" | "editor" | "viewer" {
  return value === "viewer" || value === "editor" ? value : "owner";
}

/**
 * Upserts the Vercel identity and creates one private workspace on first
 * sign-in. No request-provided workspace id is accepted here.
 */
export async function ensureVercelActor(identity: VercelIdentity, sql: NeonSql = createNeonSql()): Promise<AppActor> {
  const users = await sql.query(
    `insert into app_users (vercel_subject, email, display_name)
     values ($1, $2, $3)
     on conflict (vercel_subject) do update
       set email = excluded.email,
           display_name = excluded.display_name,
           updated_at = now()
     returning id::text, email, display_name`,
    [identity.subject, identity.email, identity.name ?? identity.username],
  ) as unknown as UserRow[];
  const user = users[0];
  if (!user) throw new Error("Kunde inte skapa den privata arbetsytans användare.");

  const memberships = await sql.query(
    `select workspace_id::text, role
       from app_workspace_memberships
      where user_id = $1::uuid
      order by case role when 'owner' then 0 when 'editor' then 1 else 2 end, created_at asc
      limit 1`,
    [user.id],
  ) as unknown as MembershipRow[];
  let membership = memberships[0];
  if (!membership) {
    const slug = workspaceSlug(identity);
    const workspaces = await sql.query(
      `insert into app_workspaces (slug, name)
       values ($1, $2)
       on conflict (slug) do update set slug = excluded.slug
       returning id::text`,
      [slug, workspaceName(identity)],
    ) as unknown as Array<{ id: string }>;
    const workspace = workspaces[0];
    if (!workspace) throw new Error("Kunde inte skapa den privata arbetsytan.");
    const inserted = await sql.query(
      `insert into app_workspace_memberships (workspace_id, user_id, role)
       values ($1::uuid, $2::uuid, 'owner')
       on conflict (workspace_id, user_id) do update set role = app_workspace_memberships.role
       returning workspace_id::text, role`,
      [workspace.id, user.id],
    ) as unknown as MembershipRow[];
    membership = inserted[0];
  }
  if (!membership) throw new Error("Kunde inte skapa åtkomst till arbetsytan.");
  return {
    userId: user.id,
    workspaceId: membership.workspace_id,
    role: asRole(membership.role),
    email: user.email,
    displayName: user.display_name,
  };
}

export async function createAppSession(actor: AppActor, sql: NeonSql = createNeonSql()): Promise<string> {
  const rawToken = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_SECONDS * 1000).toISOString();
  await sql.query(
    `insert into app_sessions (user_id, workspace_id, token_hash, expires_at)
     values ($1::uuid, $2::uuid, $3, $4::timestamptz)`,
    [actor.userId, actor.workspaceId, sessionHash(rawToken), expiresAt],
  );
  return rawToken;
}

export async function readAppSession(rawToken: string | null | undefined, sql: NeonSql = createNeonSql()): Promise<AppActor | null> {
  if (!rawToken || rawToken.length < 32) return null;
  const rows = await sql.query(
    `select
       session.user_id::text,
       membership.workspace_id::text,
       membership.role,
       user_row.email,
       user_row.display_name
     from app_sessions session
     join app_users user_row on user_row.id = session.user_id
     join app_workspace_memberships membership on membership.user_id = session.user_id
       and membership.workspace_id = session.workspace_id
     where session.token_hash = $1
       and session.revoked_at is null
       and session.expires_at > now()
     limit 1`,
    [sessionHash(rawToken)],
  ) as unknown as SessionRow[];
  const row = rows[0];
  if (!row) return null;
  // Deliberately best effort: a login remains valid if a last-seen write races
  // or the database transiently rejects that non-authoritative telemetry.
  void sql.query("update app_sessions set last_seen_at = now() where token_hash = $1", [sessionHash(rawToken)]).catch(() => undefined);
  return {
    userId: row.user_id,
    workspaceId: row.workspace_id,
    role: asRole(row.role),
    email: row.email,
    displayName: row.display_name,
  };
}

export async function revokeAppSession(rawToken: string | null | undefined, sql: NeonSql = createNeonSql()): Promise<void> {
  if (!rawToken || rawToken.length < 32) return;
  await sql.query("update app_sessions set revoked_at = now() where token_hash = $1 and revoked_at is null", [sessionHash(rawToken)]);
}

export async function getCurrentActor(): Promise<AppActor | null> {
  const cookieStore = await cookies();
  return readAppSession(cookieStore.get(SESSION_COOKIE)?.value);
}

export async function requireCurrentActor(): Promise<AppActor> {
  const actor = await getCurrentActor();
  if (!actor) throw new Error("INLOGGNING_KRÄVS");
  return actor;
}

export const appSessionCookie = {
  name: SESSION_COOKIE,
  maxAge: SESSION_MAX_AGE_SECONDS,
  options: {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  },
};
