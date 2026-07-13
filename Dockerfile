# principleDB — plain-Node serve image (issue #51, ADR-0016).
#
# Runs the same one-process Hono app the serve bin boots locally:
#   /            — public Canon search page (W2)
#   /quote/:id   — Reader (W3)
#   /connect     — connect-your-AI page (W5)
#   /api/search  — core-direct search JSON
#   /api/related — core-direct related JSON
#   POST /mcp    — stateless read-only Streamable HTTP MCP endpoint
#
# The image is portable: Fly.io is the recommended host (see fly.toml +
# SELF_HOSTING.md §8), but Hetzner or an own-box behind a Cloudflare Tunnel
# work with the same Dockerfile per ADR-0016.
#
# The stdio MCP bin (`npm run mcp`) is untouched — it's a separate entrypoint
# that a self-hoster can still launch from `tsx bin/principledb-mcp.ts`.

FROM node:22-bookworm-slim AS deps
WORKDIR /app

# Install deps against the lockfile. --ignore-scripts skips optional native
# postinstalls; the runtime deps here (pg / aws4fetch / hono / MCP SDK) have
# no native builds so this is safe and cache-friendly.
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

FROM node:22-bookworm-slim AS runtime
WORKDIR /app

# node_modules first for layer reuse across code edits.
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.json ./
COPY bin ./bin
COPY src ./src
COPY drizzle ./drizzle
COPY drizzle.config.ts ./

ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000

# Drop privileges — the upstream image ships a non-root `node` user.
USER node

EXPOSE 3000

# `npm run serve` runs `tsx bin/principledb-serve.ts`. Env (DATABASE_URL,
# ANTHROPIC_API_KEY, OPENAI_API_KEY, optional R2_*) is injected at run time
# (`docker run --env-file .env` locally; Fly secrets in prod).
CMD ["npm", "run", "serve"]
