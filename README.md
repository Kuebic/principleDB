# principleDB

> ⚠️ TODO: one-line description of what principleDB is. (Pending — fill in `CONTEXT.md` first.)

## How this project is built

principleDB follows a two-phase, spec-driven workflow:

1. **Plan** — interactive, document-first. Produces issues, `CONTEXT.md`, and ADRs.
2. **Build** — autonomous, via [Sandcastle](https://github.com/mattpocock/sandcastle), which runs Claude Code agents in isolated sandboxes against those issues.

See [WORKFLOW.md](./WORKFLOW.md) for the full pipeline and [CONTEXT.md](./CONTEXT.md) for the domain model.

## Getting started

To stand up a fresh instance (Supabase + R2 + secrets, then connect to your AI
client), follow [docs/SELF_HOSTING.md](./docs/SELF_HOSTING.md).
