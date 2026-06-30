import { describe, expect, it } from 'vitest';
import {
  REQUIRED_TABLES,
  runDoctor,
  type DoctorCheck,
  type DoctorEnv,
  type ProbeDb,
} from './doctor';

const fullEnv: DoctorEnv = {
  DATABASE_URL: 'postgres://user:pass@host:5432/db',
  ANTHROPIC_API_KEY: 'sk-ant-x',
  OPENAI_API_KEY: 'sk-x',
  R2_ACCOUNT_ID: 'acc',
  R2_ACCESS_KEY_ID: 'key',
  R2_SECRET_ACCESS_KEY: 'sec',
  R2_BUCKET: 'principledb',
  R2_ENDPOINT: 'https://acc.r2.cloudflarestorage.com',
};

const okProbe: ProbeDb = async () => ({ hasPgVector: true, tables: [...REQUIRED_TABLES] });

function findCheck(checks: DoctorCheck[], name: string): DoctorCheck | undefined {
  return checks.find((c) => c.name === name);
}

describe('runDoctor', () => {
  it('all-green when every env var is set and the DB is fully provisioned', async () => {
    const report = await runDoctor(fullEnv, okProbe);
    expect(report.ok).toBe(true);
    for (const c of report.checks) {
      expect(c.status).not.toBe('fail');
    }
  });

  it('fails on missing DATABASE_URL and skips the DB probe entirely', async () => {
    let probeCalls = 0;
    const probe: ProbeDb = async () => {
      probeCalls++;
      return { hasPgVector: true, tables: [...REQUIRED_TABLES] };
    };
    const report = await runDoctor({ ...fullEnv, DATABASE_URL: undefined }, probe);
    expect(report.ok).toBe(false);
    expect(findCheck(report.checks, 'DATABASE_URL')!.status).toBe('fail');
    expect(probeCalls).toBe(0);
  });

  it('fails on missing ANTHROPIC_API_KEY with a hint that mentions the model port (ADR-0011)', async () => {
    const report = await runDoctor({ ...fullEnv, ANTHROPIC_API_KEY: undefined }, okProbe);
    expect(report.ok).toBe(false);
    const check = findCheck(report.checks, 'ANTHROPIC_API_KEY')!;
    expect(check.status).toBe('fail');
    expect(check.detail.toLowerCase()).toMatch(/distil|model|anthropic/);
  });

  it('accepts a CLAUDE_CODE_OAUTH_TOKEN in place of ANTHROPIC_API_KEY', async () => {
    const report = await runDoctor(
      { ...fullEnv, ANTHROPIC_API_KEY: undefined, CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-x' },
      okProbe,
    );
    const check = findCheck(report.checks, 'ANTHROPIC_API_KEY')!;
    expect(check.status).toBe('ok');
    expect(check.detail).toMatch(/CLAUDE_CODE_OAUTH_TOKEN/);
    expect(report.ok).toBe(true);
  });

  it('fails on missing OPENAI_API_KEY', async () => {
    const report = await runDoctor({ ...fullEnv, OPENAI_API_KEY: undefined }, okProbe);
    expect(report.ok).toBe(false);
    expect(findCheck(report.checks, 'OPENAI_API_KEY')!.status).toBe('fail');
  });

  it('warns (not fail) when R2 vars are missing — PDF ingest needs them but the server still boots', async () => {
    const report = await runDoctor(
      {
        ...fullEnv,
        R2_ACCOUNT_ID: undefined,
        R2_ACCESS_KEY_ID: undefined,
        R2_SECRET_ACCESS_KEY: undefined,
        R2_BUCKET: undefined,
        R2_ENDPOINT: undefined,
      },
      okProbe,
    );
    expect(report.ok).toBe(true);
    const r2 = findCheck(report.checks, 'R2 (blob lake)')!;
    expect(r2.status).toBe('warn');
    expect(r2.detail).toMatch(/PDF/i);
  });

  it('fails when pgvector is not installed in the target database', async () => {
    const probe: ProbeDb = async () => ({ hasPgVector: false, tables: [...REQUIRED_TABLES] });
    const report = await runDoctor(fullEnv, probe);
    expect(report.ok).toBe(false);
    const check = findCheck(report.checks, 'pgvector extension')!;
    expect(check.status).toBe('fail');
    expect(check.detail).toMatch(/CREATE EXTENSION/);
  });

  it('fails listing missing tables when the schema is not applied', async () => {
    const probe: ProbeDb = async () => ({ hasPgVector: true, tables: ['source'] });
    const report = await runDoctor(fullEnv, probe);
    expect(report.ok).toBe(false);
    const check = findCheck(report.checks, 'schema tables')!;
    expect(check.status).toBe('fail');
    expect(check.detail).toContain('principle');
    expect(check.detail).toContain('db:migrate');
  });

  it('fails with a clear message when the DB cannot be reached', async () => {
    const probe: ProbeDb = async () => ({ error: 'getaddrinfo ENOTFOUND db.example.com' });
    const report = await runDoctor(fullEnv, probe);
    expect(report.ok).toBe(false);
    const check = findCheck(report.checks, 'postgres connectivity')!;
    expect(check.status).toBe('fail');
    expect(check.detail).toContain('ENOTFOUND');
  });

  it('REQUIRED_TABLES covers every table the production schema defines', () => {
    // Belt-and-suspenders: if a future migration adds a table, this guard
    // forces the author to update the doctor too — otherwise a fresh
    // self-hoster could silently boot against an incomplete schema.
    expect(REQUIRED_TABLES).toEqual(
      expect.arrayContaining([
        'source',
        'principle',
        'quote',
        'review_candidate',
        'dedup_decision',
        'bulk_progress',
      ]),
    );
  });
});
