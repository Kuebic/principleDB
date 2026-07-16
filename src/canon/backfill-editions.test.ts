// Backfill orchestrator over the pure `sourceToEdition` mapping (issue #60,
// PRD #58, ADR-0018). Covers the acceptance-criteria properties: every Source
// lands in exactly one Edition of its Work; a re-run is idempotent (no
// duplicate Editions, assignments unchanged); a wrong prior assignment gets
// corrected. Post-#61 `Source.editionId` is required (non-null), so the
// "initial assignment from null" scenario is gone — the assignment path is
// exercised via a defensive re-run (a Source stamped with the wrong Edition
// gets corrected).

import { describe, expect, it } from 'vitest';
import { InMemoryRepository } from './in-memory-repository';
import { backfillEditions } from './backfill-editions';
import {
  BACKFILL_EDITIONS,
  EDITION_CBG,
  EDITION_CSG,
  EDITION_DD_REVELATIONS,
  EDITION_DD_SPECIAL_GRACE,
  EDITION_DP,
  EDITION_PHG,
  EDITION_TFG,
  EDITION_TM,
  EDITION_UT,
  EDITION_WOGW,
} from './source-to-edition';
import type { Source } from './types';

function src(id: string, author: string, title: string, editionId: string): Source {
  return {
    id,
    title,
    author,
    kind: 'sermon',
    date: '2026-01-01',
    text: 'body',
    r2Key: null,
    structureMap: { kind: 'none' },
    editionId,
  };
}

// Every founding Source starts with its *correct* Edition — the state the
// live Canon has after the initial #60 backfill has run. The scenarios then
// exercise idempotence (no-op re-run) and defensive re-assignment (a Source
// mis-stamped with the wrong Edition gets corrected on the next pass).
async function seedRepresentative() {
  const repo = new InMemoryRepository();
  await repo.upsertSource(src('s1', 'SunMyungMoon-CSG', 'CSG — book1-01', EDITION_CSG));
  await repo.upsertSource(src('s2', 'Sang Hun Lee', 'UT — 01', EDITION_UT));
  await repo.upsertSource(src('s3', 'Hak Ja Han Moon', 'TM — 1', EDITION_TM));
  await repo.upsertSource(src('s4', 'Sun Myung Moon', 'Cham Bumo Gyeong — CBG-00', EDITION_CBG));
  await repo.upsertSource(src('s5', 'Sun Myung Moon', 'Pyeong Hwa Gyeong — PHG14-01', EDITION_PHG));
  await repo.upsertSource(src('s6', 'Sun Myung Moon', "The Way Of God's Will — WOGW-01", EDITION_WOGW));
  await repo.upsertSource(src('s7', '01-the-principle-of-creation', 'Ch.1', EDITION_DP));
  await repo.upsertSource(src('s8', 'Damien Dunkley', "Discourse on True Mother's Revelations — Part 01", EDITION_DD_REVELATIONS));
  await repo.upsertSource(src('s9', 'Damien Dunkley', 'The Meaning of Special Grace', EDITION_DD_SPECIAL_GRACE));
  await repo.upsertSource(src('s10', 'Sun Myung Moon', 'True Families: Gateway to Heaven', EDITION_TFG));
  return repo;
}

async function editionForSource(repo: InMemoryRepository, sourceId: string): Promise<string | null> {
  const s = await repo.getSource(sourceId);
  return s?.editionId ?? null;
}

describe('backfillEditions', () => {
  it('creates the 10 Editions and leaves already-correct Source assignments unchanged', async () => {
    const repo = await seedRepresentative();
    const result = await backfillEditions(repo);

    expect(result.editionsUpserted).toBe(10);
    expect(result.sourcesAssigned).toBe(0);
    expect(result.sourcesUnchanged).toBe(10);

    // Every seeded Edition is readable through the port.
    for (const e of BACKFILL_EDITIONS) {
      const fetched = await repo.getEdition(e.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.label).toBe(e.label);
      expect(fetched!.recension).toBe(e.recension);
      expect(fetched!.workId).toBe(e.workId);
      expect(fetched!.language).toBe('en');
    }

    // Assignments — the 9 seeded rows are in their Editions.
    expect(await editionForSource(repo, 's1')).toBe(EDITION_CSG);
    expect(await editionForSource(repo, 's2')).toBe(EDITION_UT);
    expect(await editionForSource(repo, 's3')).toBe(EDITION_TM);
    expect(await editionForSource(repo, 's4')).toBe(EDITION_CBG);
    expect(await editionForSource(repo, 's5')).toBe(EDITION_PHG);
    expect(await editionForSource(repo, 's6')).toBe(EDITION_WOGW);
    expect(await editionForSource(repo, 's7')).toBe(EDITION_DP);
    expect(await editionForSource(repo, 's8')).toBe(EDITION_DD_REVELATIONS);
    expect(await editionForSource(repo, 's9')).toBe(EDITION_DD_SPECIAL_GRACE);
    expect(await editionForSource(repo, 's10')).toBe(EDITION_TFG);
  });

  it('is idempotent — a second run produces no duplicates and no assignment changes', async () => {
    const repo = await seedRepresentative();
    await backfillEditions(repo);

    // Snapshot post-first-run state.
    const csgBefore = await repo.getEdition(EDITION_CSG);

    const second = await backfillEditions(repo);
    expect(second.sourcesUnchanged).toBe(10);
    expect(second.sourcesAssigned).toBe(0);

    // The upsert on second run is a no-op — the Edition is byte-for-byte
    // what it was before.
    const csgAfter = await repo.getEdition(EDITION_CSG);
    expect(csgAfter).toEqual(csgBefore);
  });

  it('re-routes a Source whose editionId was wrong (defensive re-run)', async () => {
    const repo = new InMemoryRepository();
    // A CSG chunk mistakenly stamped with the DP Edition — the re-run fixes it.
    await repo.upsertSource(src('s_bad', 'SunMyungMoon-CSG', 'CSG — book1-01', EDITION_DP));

    const result = await backfillEditions(repo);
    expect(result.sourcesAssigned).toBe(1);
    expect(result.sourcesUnchanged).toBe(0);
    expect(await editionForSource(repo, 's_bad')).toBe(EDITION_CSG);
  });

  it('every Source has a non-null editionId after the run (AC guarantee)', async () => {
    const repo = await seedRepresentative();
    await backfillEditions(repo);
    const refs = await repo.listSourceRefsForBackfill();
    for (const ref of refs) {
      expect(ref.editionId).not.toBeNull();
    }
  });
});
