// PROTOTYPE server (issue #43) — serves reader-prototype.html on localhost.
// Throwaway: no framework, no deps. `npm run prototype:reader` then open the URL.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const html = join(here, 'reader-prototype.html');
const port = Number(process.env.PORT) || 4319;

createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(readFileSync(html)); // re-read each request so edits show on refresh
}).listen(port, () => {
  console.log(`\n  Reader prototype (#43) → http://localhost:${port}/?variant=A`);
  console.log(`  Flip variants with the bottom bar or the ← / → keys (A, B, C).\n`);
});
