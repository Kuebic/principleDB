# principleDB core-spine prototype — THROWAWAY

> ⚠️ This is a throwaway spike, not production code. The real build lives in the PRD
> (issue #1) and its slices. Delete this whole `prototype/` directory once the question
> below is answered (capture the verdict in [NOTES.md](./NOTES.md) first).

## The question

Does distilling **real teachings** into **atomic Principles** + sharp embeddings retrieve
better than the blob-RAG approach that made Open Brain miss quotes — and what
semantic-merge threshold is right? And: can a model flag *grace tempers devotion* as an
evolution (not a contradiction to reject)?

## What it does

Real sermons (`zettlemd/sermons/*.md`) → LLM distils each into atomic Principles + verbatim
Quotes → embeds each Principle → stores vectors **in memory** → retrieves by brute-force
cosine. No Supabase, no pgvector — retrieval quality depends on the embeddings + the
distillation, not on the storage engine, so this is a faithful test of the thesis.

## Run

```bash
npm install            # one time (installs tsx)
npm run prototype      # interactive TUI
npm run prototype -- --demo   # non-interactive: distil + sample queries + evolution check
```

Uses `OPENAI_API_KEY` (or `OPENROUTER_API_KEY`) from your environment. Distilled atoms are
cached to `prototype/.cache.json` so re-runs are free; `redistill` (or deleting that file)
re-runs the LLM.

## What to look for

1. **Retrieval** — `find grace and obedience` (Open Brain returned *"No thoughts found"*).
   Do sharp, on-topic Principles surface, each with a quote + source?
2. **Distillation quality** — `list` / `prompt`. Are the Principles atomic, faithful,
   well-quoted? Tweak `pipeline.ts` → `DISTILL_SYSTEM` and `redistill`.
3. **Merge** — `thr 0.78` vs `thr 0.9`, then `merges`. Where does it merge the same idea
   vs collapse distinct ones?
4. **Evolution** — `evo`. Does it call the devotion→grace pair `tempers` (not `contradicts`)?
