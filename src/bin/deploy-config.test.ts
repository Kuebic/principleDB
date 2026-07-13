// Static assertions on the Slice W6 deploy artifacts (issue #51, ADR-0016).
// The image + host live outside code, but the *files* — Dockerfile, fly.toml,
// and SELF_HOSTING §8 — are committed; this test locks their shape so a
// silent edit can't drift the deploy path away from what the ADR promises.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();

const read = (rel: string): string => readFileSync(join(repoRoot, rel), 'utf8');

describe('Dockerfile (Slice W6, #51)', () => {
  const dockerfile = read('Dockerfile');

  it('runs the serve entrypoint (not the stdio mcp bin)', () => {
    // Dockerfile CMD must invoke serve; a plain `npm run mcp` would bind
    // stdio and never accept HTTP traffic on the exposed port.
    expect(dockerfile).toMatch(/CMD\b[^\n]*serve/);
    expect(dockerfile).not.toMatch(/CMD\b[^\n]*mcp\b/);
  });

  it('exposes port 3000 to match the serve default', () => {
    expect(dockerfile).toMatch(/EXPOSE\s+3000/);
  });

  it('sets HOSTNAME=0.0.0.0 so the container accepts external connections', () => {
    // Node servers bound to 127.0.0.1 are unreachable across the container
    // boundary; the serve bin's default HOSTNAME=0.0.0.0 must not be shadowed.
    expect(dockerfile).toMatch(/HOSTNAME[=\s]0\.0\.0\.0/);
  });
});

describe('fly.toml (Slice W6, #51)', () => {
  const fly = read('fly.toml');

  it('routes HTTP to the serve port and forces HTTPS (managed TLS)', () => {
    expect(fly).toMatch(/internal_port\s*=\s*3000/);
    expect(fly).toMatch(/force_https\s*=\s*true/);
  });

  it('keeps at least one machine running for always-on serve', () => {
    // ADR-0016: "always-on Fly.io" — auto_stop would let the machine idle to
    // zero and cold-start on the next hit, which contradicts the promise.
    expect(fly).toMatch(/min_machines_running\s*=\s*1/);
  });
});

describe('SELF_HOSTING.md §8 (Slice W6, #51)', () => {
  const doc = read('docs/SELF_HOSTING.md');

  it('no longer marks §8 as planned', () => {
    // The pre-W6 section header used "(Planned) …"; W6 flips it to shipped.
    expect(doc).not.toMatch(/##\s*8\.\s*\(Planned\)/i);
    expect(doc).not.toMatch(/Status:\s*planned,\s*not\s*yet\s*shipped/i);
  });

  it('documents the shipped serve mode + Fly + Cloudflare edge rules', () => {
    expect(doc).toMatch(/npm run serve/);
    expect(doc).toMatch(/fly\.toml/);
    expect(doc).toMatch(/Dockerfile/);
    // Cloudflare edge rate-limit rules are the deploy step per issue #51.
    expect(doc).toMatch(/Cloudflare/);
    expect(doc).toMatch(/rate\s*limit/i);
  });
});
