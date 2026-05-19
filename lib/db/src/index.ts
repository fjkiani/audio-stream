import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

// Render PostgreSQL requires SSL. Add ssl config when not in local dev.
const sslConfig =
  process.env.NODE_ENV === "production"
    ? { ssl: { rejectUnauthorized: false } }
    : {};

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ...sslConfig,
});
export const db = drizzle(pool, { schema });

export * from "./schema";
