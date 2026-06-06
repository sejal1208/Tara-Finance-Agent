import 'dotenv/config';
import { Pool } from 'pg';

const connectionString =
  process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/provue_tara';

const pool = new Pool({
  connectionString,
  ssl:
    connectionString.includes('neon.tech') || connectionString.includes('sslmode=require')
      ? { rejectUnauthorized: false }
      : false,
});

export async function query<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = []
): Promise<T[]> {
  const client = await pool.connect();
  try {
    const result = await client.query(sql, params);
    return result.rows as T[];
  } finally {
    client.release();
  }
}

export { pool };
