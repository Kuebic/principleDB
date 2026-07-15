// Helper for resolving the 25 Dunkley review-queue items. Each no-match is the
// distiller stitching two non-adjacent sentences with "..."; this reconstructs
// the SAME cleaned source text the ingest produced, then for each item pulls the
// single contiguous, claim-supporting sentence around an anchor phrase — a
// verbatim substring that WILL relocate (ADR-0007). Prints proposed quotes for
// review before we call resolve_review_item(correct).
//
//   npx tsx scripts/extract-review-quotes.ts

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const DIR =
  '/home/kenmen/code/src/github/kuebic/zettle/resources/Video/vimeo/Family Fed USA';

// Same cleaning as scripts/ingest-dunkley.ts parseTranscript (inlined to avoid
// importing that module's top-level main()).
function clean(raw: string): string {
  let body = raw;
  const fm = raw.match(/^---\n[\s\S]*?\n---\n?/);
  if (fm) body = raw.slice(fm[0].length);
  let out = '';
  for (const line of body.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const m = t.match(/^\[(\d{1,2}:\d{2}(?::\d{2})?)\]\s*(.*)$/);
    if (out.length > 0) out += ' ';
    out += m ? m[2]! : t;
  }
  return out.trim();
}

const FILE: Record<string, string> = {
  '01': '2025-01-31-01-discourse-on-true-mothers-revelations.md',
  '02': '2025-01-31-02-discourse-on-true-mothers-revelations.md',
  '03': '2025-01-31-03-discourse-on-true-mothers-revelations.md',
  '04': '2025-01-31-04-discourse-on-true-mothers-revelations.md',
  '06': '2025-01-31-06-discourse-on-true-mothers-revelations.md',
  '07': '2025-01-31-07-discourse-on-true-mothers-revelations.md',
  '09': '2025-01-31-09-discourse-on-true-mothers-revelations.md',
  '10': '2025-01-31-10-discourse-on-true-mothers-revelations.md',
};

interface Item {
  id: string;
  part: string;
  anchor: string;
  action?: 'reject';
}

const P = 'src-dunkley-2025-01-31';
const ITEMS: Item[] = [
  { id: `${P}-01-discourse-on-true-mothers-revelations#96a5e3f4#r6`, part: '01', anchor: 'becoming one that reveals the divine image' },
  { id: `${P}-01-discourse-on-true-mothers-revelations#96a5e3f4#r21`, part: '01', anchor: 'we have to know the truth of the providence' },
  { id: `${P}-02-discourse-on-true-mothers-revelations#96a5e3f4#r29`, part: '02', anchor: 'God made us in his image, both male and female' },
  { id: `${P}-02-discourse-on-true-mothers-revelations#96a5e3f4#r31`, part: '02', anchor: 'the first son or first daughter' },
  { id: `${P}-02-discourse-on-true-mothers-revelations#96a5e3f4#r54`, part: '02', anchor: 'the incredible divine beauty of a beautiful young woman' },
  { id: `${P}-02-discourse-on-true-mothers-revelations#96a5e3f4#r56`, part: '02', anchor: 'poetry and music and architecture and technology' },
  { id: `${P}-03-discourse-on-true-mothers-revelations#96a5e3f4#r12`, part: '03', anchor: 'God did not give up' },
  { id: `${P}-04-discourse-on-true-mothers-revelations#96a5e3f4#r2`, part: '04', anchor: 'He resembled God in nature' },
  { id: `${P}-04-discourse-on-true-mothers-revelations#96a5e3f4#r3`, part: '04', anchor: 'God had a child whom he could call his own' },
  { id: `${P}-04-discourse-on-true-mothers-revelations#96a5e3f4#r4`, part: '04', anchor: 'a personal and intimate relationship with God as a loving father' },
  { id: `${P}-04-discourse-on-true-mothers-revelations#96a5e3f4#r6`, part: '04', anchor: 'know the dream of God' },
  { id: `${P}-04-discourse-on-true-mothers-revelations#96a5e3f4#r8`, part: '04', anchor: 'will in that moment' },
  { id: `${P}-04-discourse-on-true-mothers-revelations#96a5e3f4#r10`, part: '04', anchor: 'illogical that for 4,000 years' },
  { id: `${P}-04-discourse-on-true-mothers-revelations#96a5e3f4#r11`, part: '04', anchor: 'another moment of divine awareness' },
  { id: `${P}-04-discourse-on-true-mothers-revelations#96a5e3f4#r13`, part: '04', anchor: 'conditions that were not yet met' },
  { id: `${P}-04-discourse-on-true-mothers-revelations#96a5e3f4#r14`, part: '04', anchor: 'emerge at that time' },
  { id: `${P}-04-discourse-on-true-mothers-revelations#96a5e3f4#r15`, part: '04', anchor: 'coming again' },
  { id: `${P}-04-discourse-on-true-mothers-revelations#96a5e3f4#r16`, part: '04', anchor: 'a certain sense of surrender' },
  { id: `${P}-04-discourse-on-true-mothers-revelations#96a5e3f4#r17`, part: '04', anchor: 'ever evolving, ever awakening' },
  { id: `${P}-06-discourse-on-true-mothers-revelations#96a5e3f4#r1`, part: '06', anchor: 'trying to establish the foundation from among fallen human beings' },
  { id: `${P}-07-discourse-on-true-mothers-revelations#96a5e3f4#r3`, part: '07', anchor: 'The only begotten daughter is not a restorational figure' },
  { id: `${P}-07-discourse-on-true-mothers-revelations#96a5e3f4#r5`, part: '07', anchor: 'I am your daughter' },
  { id: `${P}-09-discourse-on-true-mothers-revelations#96a5e3f4#r6`, part: '09', anchor: 'everything in pairs' },
  { id: `${P}-10-discourse-on-true-mothers-revelations#96a5e3f4#r15`, part: '10', anchor: 'all indemnity had been paid' },
  { id: `${P}-10-discourse-on-true-mothers-revelations#96a5e3f4#r16`, part: '10', anchor: 'If the truth of the only begotten daughter was properly revealed' },
];

const TERM = new Set(['.', '?', '!']);
function sentenceAround(text: string, anchor: string): string | null {
  const idx = text.toLowerCase().indexOf(anchor.toLowerCase());
  if (idx < 0) return null;
  let s = idx;
  while (s > 0 && !TERM.has(text[s - 1]!)) s--;
  while (text[s] === ' ') s++;
  let e = idx + anchor.length;
  while (e < text.length && !TERM.has(text[e]!)) e++;
  if (e < text.length) e++;
  return text.slice(s, e).trim();
}

const cache: Record<string, string> = {};
for (const it of ITEMS) {
  const key = it.part;
  if (!cache[key]) cache[key] = clean(readFileSync(join(DIR, FILE[key]!), 'utf8'));
  const quote = sentenceAround(cache[key]!, it.anchor);
  const rid = it.id.split('#').pop();
  if (!quote) {
    console.log(`❌ ${it.part}/${rid}  ANCHOR NOT FOUND: "${it.anchor}"`);
  } else {
    console.log(`✓ ${it.part}/${rid}  (${quote.length} chars)\n    ${quote}\n`);
  }
}
