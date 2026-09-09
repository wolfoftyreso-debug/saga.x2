export const SAGA_PROJECT_ID: string;
export class MigrationGuardError extends Error { code: string; constructor(code: string); }
export interface Migration { name: string; sha256: string; body: string; }
export interface MigrationTarget { host: string; database: string; project: string; }
export interface MigrationClient { query(sql: string, values?: unknown[]): Promise<{ rows: unknown[] }>; }
export interface MigrationReport {
  ok: true; mode: "apply" | "status"; previouslyApplied: number; applied: number;
  pending: number; total: number; source: "pristine" | "verified-ledger";
}
export function parseArguments(args: string[]): { apply: boolean; json: boolean; help: boolean; expectedHost: string; expectedProject: string; };
export function validateTarget(input: { connectionString: string; expectedHost: string; expectedProject: string; linkedProject: string; }): MigrationTarget;
export function sqlStatements(sql: string): { start: number; end: number; command: string; }[];
export function prepareMigration(name: string, sql: string): Migration;
export function loadMigrations(root: string): Migration[];
export function validateLedger(rows: { sequence: number; filename: string; sha256: string; }[], migrations: Migration[]): number;
export function runMigrations(client: MigrationClient, migrations: Migration[], target: MigrationTarget, apply?: boolean, onApplied?: (entry: { sequence: number; filename: string; }) => void): Promise<MigrationReport>;
export function safeFailure(error: unknown): { ok: false; code: string; detail: string; };
export function main(args?: string[], root?: string): Promise<number>;
