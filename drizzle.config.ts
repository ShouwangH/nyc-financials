import type { Config } from 'drizzle-kit';

export default {
  driver: 'pg',
  out: './server/lib',
  schema: './server/lib/schema.ts',
  dbCredentials: {
    connectionString: process.env.DATABASE_URL!,
  },
} satisfies Config;
