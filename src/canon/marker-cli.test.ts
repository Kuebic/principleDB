import { describe, expect, it } from 'vitest';
import { MarkerCliExtractor, type MarkerProcessRunner } from './marker-cli';

describe('MarkerCliExtractor', () => {
  it('runs the CPU script on target=cpu, captures its stdout as the markdown', async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const runner: MarkerProcessRunner = async (cmd, args) => {
      calls.push({ cmd, args });
      return '{0}---\nHello from CPU';
    };
    const extractor = new MarkerCliExtractor({
      cpuScript: '/opt/zettle/scripts/ingest_pdf.py',
      remoteScript: '/opt/zettle/scripts/ingest_remote.sh',
      runner,
    });

    const out = await extractor.extract('/books/sample.pdf', { target: 'cpu' });

    expect(calls).toEqual([
      { cmd: '/opt/zettle/scripts/ingest_pdf.py', args: ['/books/sample.pdf'] },
    ]);
    expect(out.markdown).toBe('{0}---\nHello from CPU');
  });

  it('runs the remote-GPU script on target=remote-gpu', async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const runner: MarkerProcessRunner = async (cmd, args) => {
      calls.push({ cmd, args });
      return '{0}---\nHello from A4500';
    };
    const extractor = new MarkerCliExtractor({
      cpuScript: '/opt/zettle/scripts/ingest_pdf.py',
      remoteScript: '/opt/zettle/scripts/ingest_remote.sh',
      runner,
    });

    const out = await extractor.extract('/books/big.pdf', { target: 'remote-gpu' });

    expect(calls).toEqual([
      { cmd: '/opt/zettle/scripts/ingest_remote.sh', args: ['/books/big.pdf'] },
    ]);
    expect(out.markdown).toBe('{0}---\nHello from A4500');
  });

  it('surfaces runner errors so the caller can route a failed Source to a clear error', async () => {
    const runner: MarkerProcessRunner = async () => {
      throw new Error('marker OOM');
    };
    const extractor = new MarkerCliExtractor({
      cpuScript: '/cpu',
      remoteScript: '/remote',
      runner,
    });
    await expect(extractor.extract('/x.pdf', { target: 'cpu' })).rejects.toThrow('marker OOM');
  });
});
