// drizzle-kit reads this to generate SQL migrations from src/db/schema.ts.
// Migrations are never hand-written (ADR-0005); they fall out of the declarative
// schema. The DATABASE_URL is read at apply-time (drizzle-kit migrate / push),
// not at generate-time, so this config is safe to keep in git.

import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://localhost:5432/principledb',
  },
  strict: true,
  verbose: true,
});
