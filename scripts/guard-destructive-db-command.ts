import 'dotenv/config';

// Blocks a destructive Prisma/DB command from ever running against the
// shared Supabase database again — the root cause behind the Franchise
// table (and most of the rest of the DB) being wiped: `prisma migrate dev`
// hit a migration-drift prompt and someone accepted the schema reset it
// offered, which drops and recreates the entire public schema.
//
// Usage: prepend to any destructive script/command, e.g.
//   "prisma:migrate": "tsx scripts/guard-destructive-db-command.ts && prisma migrate dev"
// Bypass (only when you really mean it, e.g. a genuine local dev DB that
// happens to resolve to a non-Supabase host already won't need this at
// all): ALLOW_DESTRUCTIVE_DB_COMMAND=true.

const PROD_HOST_PATTERNS = [/supabase\.co/i, /supabase\.com/i, /pooler\.supabase/i];

function hostFromUrl(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

function main() {
  if (process.env.ALLOW_DESTRUCTIVE_DB_COMMAND === 'true') {
    console.warn('⚠️  ALLOW_DESTRUCTIVE_DB_COMMAND=true — skipping the production-DB guard. Proceeding.');
    return;
  }

  const urls = [
    ['DATABASE_URL', process.env.DATABASE_URL],
    ['DIRECT_URL', process.env.DIRECT_URL],
  ] as const;

  for (const [name, url] of urls) {
    const host = hostFromUrl(url);
    if (host && PROD_HOST_PATTERNS.some((p) => p.test(host))) {
      console.error(
        `\n🛑 BLOCKED: ${name} points at a Supabase host (${host}).\n` +
        `This command (migrate dev / migrate reset / a data-wipe script) is only safe against a\n` +
        `disposable local/dev database. Running it here would reset or wipe shared, real data —\n` +
        `exactly what happened before (see the Franchise-table investigation).\n\n` +
        `If you actually intend to apply a formal migration to this environment, use:\n` +
        `  npx prisma migrate deploy\n` +
        `(applies pending migrations only — never resets, never prompts, never touches data)\n\n` +
        `If you are certain this destructive command is intentional, re-run with:\n` +
        `  ALLOW_DESTRUCTIVE_DB_COMMAND=true <your command>\n`
      );
      process.exit(1);
    }
  }
}

main();
