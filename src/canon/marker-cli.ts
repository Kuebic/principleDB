// MarkerCliExtractor — wraps the zettle vault's `ingest_pdf.py` (CPU) and
// `ingest_remote.sh` (remote A4500 via rsync) per ADR-0010. Both scripts already
// implement the Marker pipeline; this thin wrapper picks the right one for the
// execution target and captures its stdout (the cleaned, page-anchored
// markdown) as the MarkerArtifact. The process runner is injected so tests
// stay deterministic; production wires it to child_process.execFile.

import { execFile } from 'node:child_process';
import type { ExtractOptions, MarkerArtifact, PdfExtractor } from './marker';

export type MarkerProcessRunner = (cmd: string, args: string[]) => Promise<string>;

export interface MarkerCliOptions {
  cpuScript: string;
  remoteScript: string;
  runner?: MarkerProcessRunner;
}

const defaultRunner: MarkerProcessRunner = (cmd, args) =>
  new Promise<string>((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 1024 * 1024 * 256, encoding: 'utf8' }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });

export class MarkerCliExtractor implements PdfExtractor {
  private readonly cpuScript: string;
  private readonly remoteScript: string;
  private readonly runner: MarkerProcessRunner;

  constructor(opts: MarkerCliOptions) {
    this.cpuScript = opts.cpuScript;
    this.remoteScript = opts.remoteScript;
    this.runner = opts.runner ?? defaultRunner;
  }

  async extract(pdfPath: string, opts: ExtractOptions): Promise<MarkerArtifact> {
    const cmd = opts.target === 'remote-gpu' ? this.remoteScript : this.cpuScript;
    const markdown = await this.runner(cmd, [pdfPath]);
    return { markdown };
  }
}
