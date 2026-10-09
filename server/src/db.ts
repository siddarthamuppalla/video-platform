import pg from "pg";
import { config } from "./config.js";

// Return BIGINT columns (file sizes) as numbers; uploads are capped well below 2^53.
pg.types.setTypeParser(20, (v) => Number(v));

export const pool = new pg.Pool({ connectionString: config.databaseUrl });

export async function query<T extends pg.QueryResultRow = any>(text: string, params: unknown[] = []) {
  return pool.query<T>(text, params);
}
