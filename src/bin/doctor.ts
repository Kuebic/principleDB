// runDoctor — the self-host preflight (issue #8). Verifies env wiring + DB
// state and emits a checklist the Owner can read top-to-bottom. The point is
// to make a guided setup feasible: instead of "the MCP server crashed with a
// stack trace, good luck", the Owner runs `npm run doctor` and gets a list
// like "DATABASE_URL: ok, pgvector: missing — enable it in Supabase →
// Database → Extensions".
//
// The function is pure: it takes the env object and a `ProbeDb` callback,
// so tests can drive every failure case without a Postgres on the bench.
// The CLI entrypoint (`bin/principledb-doctor.ts`) wires a real probe.

export interface DoctorEnv {
  DATABASE_URL?: string;
  ANTHROPIC_API_KEY?: string;
  CLAUDE_CODE_OAUTH_TOKEN?: string;
  OPENAI_API_KEY?: string;
  PRINCIPLEDB_DISTIL_MODEL?: string;
  PRINCIPLEDB_CONFIRM_MODEL?: string;
  PRINCIPLEDB_EMBED_MODEL?: string;
  R2_ACCOUNT_ID?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  R2_BUCKET?: string;
  R2_ENDPOINT?: string;
}

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface DoctorCheck {
  name: string;
  status: CheckStatus;
  detail: string;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  ok: boolean;
}

export interface DbProbeResult {
  hasPgVector: boolean;
  tables: string[];
}

export interface DbProbeError {
  error: string;
}

export type ProbeDb = (databaseUrl: string) => Promise<DbProbeResult | DbProbeError>;

// Every table the production schema declares (see `src/db/schema.ts` and
// `drizzle/000*_*.sql`). The doctor reports any missing table by name so the
// Owner knows exactly which migration was skipped.
export const REQUIRED_TABLES = [
  'source',
  'principle',
  'quote',
  'review_candidate',
  'dedup_decision',
  'bulk_progress',
] as const;

const R2_VARS = [
  'R2_ACCOUNT_ID',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_BUCKET',
  'R2_ENDPOINT',
] as const;

export async function runDoctor(env: DoctorEnv, probeDb: ProbeDb): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];

  checks.push(
    requiredEnvCheck(
      'DATABASE_URL',
      env.DATABASE_URL,
      'Supabase pooler URL (port 6543). Settings → Database → Connection string.',
    ),
  );
  checks.push(anthropicCredentialCheck(env));
  checks.push(
    requiredEnvCheck(
      'OPENAI_API_KEY',
      env.OPENAI_API_KEY,
      'embedding port (ADR-0011). Get a key from https://platform.openai.com/api-keys.',
    ),
  );
  checks.push(r2Check(env));
  checks.push(modelOverrideNote(env));

  if (env.DATABASE_URL) {
    const probe = await probeDb(env.DATABASE_URL);
    if ('error' in probe) {
      checks.push({
        name: 'postgres connectivity',
        status: 'fail',
        detail: probe.error,
      });
    } else {
      checks.push({
        name: 'pgvector extension',
        status: probe.hasPgVector ? 'ok' : 'fail',
        detail: probe.hasPgVector
          ? 'enabled'
          : 'missing — enable in Supabase → Database → Extensions, or run `CREATE EXTENSION vector;` in the SQL editor.',
      });
      const missing = REQUIRED_TABLES.filter((t) => !probe.tables.includes(t));
      checks.push({
        name: 'schema tables',
        status: missing.length === 0 ? 'ok' : 'fail',
        detail:
          missing.length === 0
            ? `all ${REQUIRED_TABLES.length} tables present`
            : `missing ${missing.join(', ')} — run \`npm run db:migrate\`.`,
      });
    }
  }

  const ok = checks.every((c) => c.status !== 'fail');
  return { checks, ok };
}

export function formatReport(report: DoctorReport): string {
  const lines: string[] = [];
  for (const c of report.checks) {
    lines.push(`  ${badge(c.status)}  ${c.name} — ${c.detail}`);
  }
  lines.push('');
  lines.push(report.ok ? 'doctor: OK' : 'doctor: FAILED — see entries marked fail above.');
  return lines.join('\n');
}

function badge(status: CheckStatus): string {
  switch (status) {
    case 'ok':
      return '[ok]  ';
    case 'warn':
      return '[warn]';
    case 'fail':
      return '[fail]';
  }
}

// The distil model port (ADR-0011) is satisfied by an Anthropic API key OR a
// Claude Code OAuth token. Keep the check name 'ANTHROPIC_API_KEY' so the
// checklist reads consistently; the detail names whichever credential is in use.
function anthropicCredentialCheck(env: DoctorEnv): DoctorCheck {
  if (env.ANTHROPIC_API_KEY) {
    return { name: 'ANTHROPIC_API_KEY', status: 'ok', detail: 'set' };
  }
  if (env.CLAUDE_CODE_OAUTH_TOKEN) {
    return {
      name: 'ANTHROPIC_API_KEY',
      status: 'ok',
      detail: 'set via CLAUDE_CODE_OAUTH_TOKEN (Claude Code subscription)',
    };
  }
  return {
    name: 'ANTHROPIC_API_KEY',
    status: 'fail',
    detail:
      'missing — distil model port (ADR-0011). Set ANTHROPIC_API_KEY (https://console.anthropic.com) or a CLAUDE_CODE_OAUTH_TOKEN. Default model is claude-opus-4-8; override with PRINCIPLEDB_DISTIL_MODEL.',
  };
}

function requiredEnvCheck(name: string, value: string | undefined, hint: string): DoctorCheck {
  if (value) {
    return { name, status: 'ok', detail: 'set' };
  }
  return { name, status: 'fail', detail: `missing — ${hint}` };
}

function r2Check(env: DoctorEnv): DoctorCheck {
  const presentCount = R2_VARS.filter((k) => env[k]).length;
  if (presentCount === R2_VARS.length) {
    return { name: 'R2 (blob lake)', status: 'ok', detail: `all ${R2_VARS.length} vars set` };
  }
  if (presentCount === 0) {
    return {
      name: 'R2 (blob lake)',
      status: 'warn',
      detail: `unset — the MCP server still boots, but PDF ingest will fail. Create a Cloudflare R2 bucket and set ${R2_VARS.join(', ')}.`,
    };
  }
  return {
    name: 'R2 (blob lake)',
    status: 'warn',
    detail: `partially set — fill in all of ${R2_VARS.join(', ')} before ingesting PDFs.`,
  };
}

function modelOverrideNote(env: DoctorEnv): DoctorCheck {
  const distil = env.PRINCIPLEDB_DISTIL_MODEL ?? '(default: claude-opus-4-8)';
  const confirm = env.PRINCIPLEDB_CONFIRM_MODEL ?? '(default: claude-haiku-4-5)';
  const embed = env.PRINCIPLEDB_EMBED_MODEL ?? '(default: text-embedding-3-small)';
  return {
    name: 'model configuration',
    status: 'ok',
    detail: `distil = ${distil}; confirm = ${confirm}; embed = ${embed}.`,
  };
}
