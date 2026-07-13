// Per-request access log (issue #49): one line per HTTP request with method,
// path, status, IP, and user-agent. Written for the deployed serving process
// so any surge / abuse is diagnosable from the process logs alone. Emit via
// an injectable sink so tests can capture entries without touching stdout.
//
// Kept intentionally coarse — no request bodies, no MCP JSON-RPC methods —
// so the log stays PII-free and cheap to write.

import type { MiddlewareHandler } from 'hono';
import { extractClientIp } from './rate-limit';

export interface RequestLogEntry {
  method: string;
  path: string;
  status: number;
  ip: string;
  userAgent: string;
}

export interface RequestLoggerOptions {
  log?: (entry: RequestLogEntry) => void;
}

// Format a log entry for stdout — one compact line per request.
export function formatRequestLog(entry: RequestLogEntry): string {
  return (
    `${entry.method} ${entry.path} ${entry.status} ` +
    `ip=${entry.ip} ua=${JSON.stringify(entry.userAgent)}`
  );
}

export function createRequestLogger(
  options: RequestLoggerOptions = {},
): MiddlewareHandler {
  const log = options.log ?? ((entry) => process.stdout.write(`${formatRequestLog(entry)}\n`));
  return async (c, next) => {
    await next();
    log({
      method: c.req.method,
      path: new URL(c.req.url).pathname,
      status: c.res.status,
      ip: extractClientIp(c),
      userAgent: c.req.header('user-agent') ?? '-',
    });
  };
}
