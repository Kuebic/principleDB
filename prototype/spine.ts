// THROWAWAY PROTOTYPE — principleDB core-spine.  Run: npm run prototype   (demo: npm run prototype -- --demo)
//
// QUESTION it answers: Does distilling REAL teachings into ATOMIC Principles + sharp
// embeddings retrieve better than blob-RAG (the user's Open Brain), and what semantic-
// merge threshold is right? Plus: can a model flag grace-tempers-devotion as an evolution?
//
// Throwaway: in-memory store + a local prototype/.cache.json for the distilled atoms
// (so re-runs are free). Delete the whole prototype/ dir when the question is answered.

import { readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import {
  cosine, bestMatch, stripFrontmatter,
  DISTILL_SYSTEM, distillUser, RELATION_SYSTEM,
  type Principle,
} from './pipeline';
import { chatJSON, embed, modelInfo } from './llm';

const SERMON_DIR = '/home/kenmen/code/src/github/kuebic/zettlemd/sermons';
const SOURCES = [
  // Sin / repentance cluster
  '2026-05-15-sin-is-missing-the-mark.md',
  '2026-05-15-why-god-couldnt-just-undo-the-fall.md',
  '2026-07-05-repentance-is-how-love-moves.md',
  // Outreach / "the person not yet here" cluster (should overlap → merges)
  '2026-05-31-crossing-the-room-is-obedience.md',
  '2026-05-24-the-empty-seat-is-the-assignment.md',
  '2026-06-07-sunday-belongs-to-the-person-not-yet-here.md',
  '2026-06-14-every-member-is-a-minister.md',
  '2026-06-28-family-is-what-we-extend.md',
  // Devotion / "stay close to the source" cluster (should overlap → merges)
  '2026-05-03-the-strongest-witness-is-a-life.md',
  '2026-05-10-you-cannot-pour-from-a-well.md',
  '2026-06-21-faithful-for-forty-years.md',
  '2026-05-17-the-blessing-is-good-news.md',
];
const CACHE = new URL('./.cache.json', import.meta.url);

// Deterministic evolution fixture: an older strict-devotion emphasis vs a newer grace one.
const EVO_A = 'A believer must give total, unconditional devotion to God, holding nothing back; any failure is a betrayal.';
const EVO_B = 'Grace meets us in our failures; real devotion grows from being loved first, not from fear of betraying God.';

type Atom = { claim: string; quote: string; locator: string | null; sourceId: string; sourceTitle: string; embedding: number[] };

const B = '\x1b[1m', D = '\x1b[2m', R = '\x1b[0m', G = '\x1b[32m', Y = '\x1b[33m';
let atoms: Atom[] = [];
let principles: Principle[] = [];
let merges: string[] = [];
let threshold = 0.82;
let last = 'Booting…';

function rebuild() {
  principles = []; merges = [];
  let n = 0;
  for (const a of atoms) {
    const { bestId, score } = bestMatch(a.embedding, principles);
    if (bestId && score >= threshold) {
      const p = principles.find((x) => x.id === bestId)!;
      p.quotes.push({ verbatim: a.quote, sourceId: a.sourceId, sourceTitle: a.sourceTitle, locator: a.locator ? { raw: a.locator } : null });
      merges.push(`${score.toFixed(3)}  "${a.claim}"  →  "${p.claim}"`);
    } else {
      principles.push({ id: `p${++n}`, claim: a.claim, embedding: a.embedding, quotes: [{ verbatim: a.quote, sourceId: a.sourceId, sourceTitle: a.sourceTitle, locator: a.locator ? { raw: a.locator } : null }] });
    }
  }
}

async function distillAll() {
  atoms = [];
  for (const f of SOURCES) {
    const raw = await readFile(`${SERMON_DIR}/${f}`, 'utf8');
    const { title, body } = stripFrontmatter(raw);
    last = `Distilling ${f}…`; if (!process.argv.includes('--demo')) render(); else console.log(last);
    const out = await chatJSON(DISTILL_SYSTEM, distillUser(title ?? f, body));
    const items = (Array.isArray(out?.principles) ? out.principles : []).filter((x: any) => x?.claim && x?.quote);
    const embs = await embed(items.map((i: any) => i.claim));
    items.forEach((it: any, i: number) => atoms.push({ claim: it.claim, quote: it.quote, locator: it.locator_hint ?? null, sourceId: f, sourceTitle: title ?? f, embedding: embs[i] }));
  }
  await writeFile(CACHE, JSON.stringify({ atoms }), 'utf8');
}

async function boot() {
  if (existsSync(CACHE)) { try { atoms = JSON.parse(await readFile(CACHE, 'utf8')).atoms ?? []; } catch { atoms = []; } }
  if (!atoms.length) await distillAll();
  rebuild();
  last = `${atoms.length} atoms from ${SOURCES.length} sermons → ${principles.length} Principles, ${merges.length} merges @ threshold ${threshold}.`;
}

async function findStr(q: string): Promise<string> {
  if (!q) return 'find what? e.g. "find grace and obedience"';
  const [qe] = await embed([q]);
  const ranked = principles.map((p) => ({ p, s: cosine(qe, p.embedding) })).sort((a, b) => b.s - a.s).slice(0, 5);
  const lines = ranked.map(({ p, s }) => {
    const qt = p.quotes[0];
    const cite = `${qt.sourceTitle}${qt.locator?.raw ? ` · ${qt.locator.raw}` : ''}${p.quotes.length > 1 ? ` (+${p.quotes.length - 1} more)` : ''}`;
    return `${G}${s.toFixed(3)}${R} ${B}${p.claim}${R}\n      ${D}“${qt.verbatim.slice(0, 150).replace(/\s+/g, ' ')}…”${R}\n      ${D}— ${cite}${R}`;
  });
  return `Top ${ranked.length} for ${Y}"${q}"${R}:\n\n  ` + lines.join('\n\n  ');
}

async function evoStr(args: string[]): Promise<string> {
  let a = EVO_A, b = EVO_B, label = 'fixture (devotion → grace)';
  const i = +args[0], j = +args[1];
  if (args.length === 2 && principles[i] && principles[j]) { a = principles[i].claim; b = principles[j].claim; label = `P${i} vs P${j}`; }
  const out = await chatJSON(RELATION_SYSTEM, `A (older): ${a}\nB (newer): ${b}`);
  return `${B}Evolution check${R} (${label})\n  A: ${D}${a}${R}\n  B: ${D}${b}${R}\n  → ${G}${out.relation}${R}: ${out.explanation}`;
}

const listStr = () => 'Principles:\n  ' + principles.map((p, i) => `${D}P${i}${R} ${p.claim} ${D}(${p.quotes.length}q)${R}`).join('\n  ');
const mergesStr = () => merges.length ? 'Merges:\n  ' + merges.join('\n  ') : 'No merges at this threshold.';

function render() {
  console.clear();
  const mi = (() => { try { return modelInfo(); } catch { return { distill: '?', embed: '?', baseUrl: 'NO API KEY' }; } })();
  console.log(`${B}principleDB · core-spine PROTOTYPE${R} ${D}(throwaway)${R}`);
  console.log(`${D}distill=${mi.distill}  embed=${mi.embed}  @ ${mi.baseUrl}${R}\n`);
  console.log(`${B}Store${R}  ${principles.length} Principles · ${atoms.length} atoms · ${merges.length} merges · threshold ${B}${threshold}${R}\n`);
  console.log(`${B}Last:${R} ${last}\n`);
  console.log(`${B}Commands${R}`);
  console.log(`  ${B}find ${R}${D}<query>${R}   semantic search (try: find grace and obedience)`);
  console.log(`  ${B}list${R}           list all Principles`);
  console.log(`  ${B}thr ${R}${D}<0-1>${R}     set merge threshold & rebuild`);
  console.log(`  ${B}merges${R}         show what merged into what`);
  console.log(`  ${B}evo${R} ${D}[i j]${R}     relation check: grace-vs-devotion fixture (or two Principles)`);
  console.log(`  ${B}prompt${R}         print the distillation prompt`);
  console.log(`  ${B}redistill${R}      wipe cache & re-distil`);
  console.log(`  ${B}help${R}   ${B}quit${R}\n`);
}

async function demo() {
  await boot();
  const mi = modelInfo();
  console.log(`\n${B}=== principleDB core-spine DEMO ===${R}`);
  console.log(`${D}distill=${mi.distill}  embed=${mi.embed}${R}`);
  console.log(`\n${B}${atoms.length} atoms from ${SOURCES.length} sermons${R}\n`);
  // Threshold sweep — how merge behaves across thresholds (what we couldn't test before).
  console.log(`${B}Merge threshold sweep${R}`);
  for (const t of [0.72, 0.76, 0.80, 0.84, 0.88, 0.92]) {
    threshold = t; rebuild();
    console.log(`  thr ${t.toFixed(2)} → ${principles.length} Principles, ${B}${merges.length} merges${R}`);
  }
  threshold = 0.72; rebuild();
  console.log(`\n${B}Merges @ ${threshold}${R}\n` + mergesStr());
  console.log('\n' + listStr());
  for (const q of ['grace and obedience', 'reaching the person not yet here', 'staying close to God as the source', 'what is sin']) {
    console.log('\n' + await findStr(q));
  }
  console.log('\n' + await evoStr([]));
  console.log(`\n${D}(interactive mode: npm run prototype)${R}`);
}

async function main() {
  if (process.argv.includes('--demo')) { await demo(); return; }
  await boot();
  const rl = readline.createInterface({ input, output });
  for (;;) {
    render();
    const line = (await rl.question('> ')).trim();
    const [cmd, ...rest] = line.split(/\s+/);
    try {
      if (cmd === 'quit' || cmd === 'exit') break;
      else if (cmd === 'find') last = await findStr(rest.join(' '));
      else if (cmd === 'list') last = listStr();
      else if (cmd === 'thr') { const t = parseFloat(rest[0]); if (t >= 0 && t <= 1) { threshold = t; rebuild(); last = `threshold=${threshold} → ${principles.length} Principles, ${merges.length} merges.`; } else last = 'thr needs a number 0..1'; }
      else if (cmd === 'merges') last = mergesStr();
      else if (cmd === 'evo') last = await evoStr(rest);
      else if (cmd === 'prompt') last = DISTILL_SYSTEM;
      else if (cmd === 'redistill') { await rm(CACHE, { force: true }); await distillAll(); rebuild(); last = `Re-distilled → ${principles.length} Principles, ${merges.length} merges.`; }
      else if (cmd === 'help' || cmd === '') last = 'find <q> · list · thr <n> · merges · evo [i j] · prompt · redistill · quit';
      else last = `unknown command: ${cmd}`;
    } catch (e: any) { last = `${Y}ERROR${R}: ${e.message}`; }
  }
  rl.close();
  console.clear();
  console.log('Prototype closed. Capture the verdict → prototype/NOTES.md');
}

main();
