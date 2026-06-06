/**
 * Ingest script — populates Postgres from a snapshot folder.
 *
 * Usage (Windows CMD):
 *   set DATA_DIR=./data/sample_a && npx tsx scripts/ingest.ts
 *
 * Usage (Mac/Linux):
 *   DATA_DIR=./data/sample_a npx tsx scripts/ingest.ts
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Pool } from 'pg';
import 'dotenv/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/provue_tara';
const DATA_DIR = process.env.DATA_DIR || './data/sample_a';

const snapshot = path.basename(path.resolve(DATA_DIR));
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes('neon.tech') || DATABASE_URL.includes('sslmode=require')
    ? { rejectUnauthorized: false }
    : false,
});

async function runSQL(sql: string, params: unknown[] = []) {
  const client = await pool.connect();
  try {
    return await client.query(sql, params);
  } finally {
    client.release();
  }
}

async function applySchema() {
  // Create tables directly — avoids issues with SQL comment parsing
  await runSQL(`
    CREATE TABLE IF NOT EXISTS transactions (
      id           TEXT PRIMARY KEY,
      date         DATE NOT NULL,
      merchant     TEXT NOT NULL,
      category     TEXT NOT NULL DEFAULT 'uncategorized',
      amount       NUMERIC(12, 2) NOT NULL,
      currency     TEXT NOT NULL DEFAULT 'INR',
      memo         TEXT,
      snapshot     TEXT NOT NULL
    )
  `);

  await runSQL(`
    CREATE TABLE IF NOT EXISTS funds (
      id           TEXT NOT NULL,
      name         TEXT NOT NULL,
      category     TEXT NOT NULL,
      snapshot     TEXT NOT NULL,
      PRIMARY KEY (id, snapshot)
    )
  `);

  await runSQL(`
    CREATE TABLE IF NOT EXISTS fund_nav (
      fund_id      TEXT NOT NULL,
      snapshot     TEXT NOT NULL,
      nav_date     DATE NOT NULL,
      nav_value    NUMERIC(12, 4) NOT NULL,
      PRIMARY KEY (fund_id, snapshot, nav_date)
    )
  `);

  await runSQL(`
    CREATE TABLE IF NOT EXISTS holdings (
      fund_id        TEXT NOT NULL,
      fund_name      TEXT NOT NULL,
      units          NUMERIC(16, 6) NOT NULL,
      purchase_date  DATE NOT NULL,
      purchase_nav   NUMERIC(12, 4) NOT NULL,
      snapshot       TEXT NOT NULL,
      PRIMARY KEY (fund_id, snapshot)
    )
  `);

  // Indexes
  await runSQL(`CREATE INDEX IF NOT EXISTS idx_txn_date      ON transactions (date)`);
  await runSQL(`CREATE INDEX IF NOT EXISTS idx_txn_category  ON transactions (category)`);
  await runSQL(`CREATE INDEX IF NOT EXISTS idx_txn_merchant  ON transactions (merchant)`);
  await runSQL(`CREATE INDEX IF NOT EXISTS idx_txn_amount    ON transactions (amount)`);
  await runSQL(`CREATE INDEX IF NOT EXISTS idx_txn_snapshot  ON transactions (snapshot)`);
  await runSQL(`CREATE INDEX IF NOT EXISTS idx_nav_fund_date ON fund_nav (fund_id, snapshot, nav_date)`);
  await runSQL(`CREATE INDEX IF NOT EXISTS idx_holdings_snap ON holdings (snapshot)`);

  console.log('✅ Schema applied');
}

async function ingestTransactions() {
  const filePath = path.join(DATA_DIR, 'transactions.json');
  if (!fs.existsSync(filePath)) throw new Error(`Missing ${filePath}`);
  const txns: {
    id: string; date: string; merchant: string; category?: string;
    amount: number; currency?: string; memo?: string;
  }[] = JSON.parse(fs.readFileSync(filePath, 'utf8'));

  await runSQL('DELETE FROM transactions WHERE snapshot = $1', [snapshot]);

  // Batch insert for speed
  let count = 0;
  const BATCH = 100;
  for (let i = 0; i < txns.length; i += BATCH) {
    const batch = txns.slice(i, i + BATCH);
    for (const t of batch) {
      await runSQL(
        `INSERT INTO transactions (id, date, merchant, category, amount, currency, memo, snapshot)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (id) DO UPDATE SET
           date=EXCLUDED.date, merchant=EXCLUDED.merchant,
           category=EXCLUDED.category, amount=EXCLUDED.amount,
           currency=EXCLUDED.currency, memo=EXCLUDED.memo, snapshot=EXCLUDED.snapshot`,
        [t.id, t.date, t.merchant, t.category || 'uncategorized',
         t.amount, t.currency || 'INR', t.memo || null, snapshot]
      );
      count++;
    }
    process.stdout.write(`\r  Transactions: ${count}/${txns.length}`);
  }
  console.log(`\n✅ Transactions: ${count} rows (${snapshot})`);
}

async function ingestFunds() {
  const filePath = path.join(DATA_DIR, 'funds.json');
  if (!fs.existsSync(filePath)) throw new Error(`Missing ${filePath}`);
  const funds: {
    id: string; name: string; category: string;
    nav: { date: string; value: number }[];
  }[] = JSON.parse(fs.readFileSync(filePath, 'utf8'));

  await runSQL('DELETE FROM funds WHERE snapshot = $1', [snapshot]);
  await runSQL('DELETE FROM fund_nav WHERE snapshot = $1', [snapshot]);

  let fundCount = 0, navCount = 0;
  for (const fund of funds) {
    await runSQL(
      `INSERT INTO funds (id, name, category, snapshot) VALUES ($1, $2, $3, $4)
       ON CONFLICT (id, snapshot) DO UPDATE SET name=EXCLUDED.name, category=EXCLUDED.category`,
      [fund.id, fund.name, fund.category, snapshot]
    );
    fundCount++;
    for (const nav of fund.nav || []) {
      await runSQL(
        `INSERT INTO fund_nav (fund_id, snapshot, nav_date, nav_value)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (fund_id, snapshot, nav_date) DO UPDATE SET nav_value=EXCLUDED.nav_value`,
        [fund.id, snapshot, nav.date, nav.value]
      );
      navCount++;
    }
  }
  console.log(`✅ Funds: ${fundCount} funds, ${navCount} NAV points (${snapshot})`);
}

async function ingestHoldings() {
  const filePath = path.join(DATA_DIR, 'holdings.json');
  if (!fs.existsSync(filePath)) throw new Error(`Missing ${filePath}`);
  const holdings: {
    fund_id: string; fund_name: string; units: number;
    purchase_date: string; purchase_nav: number;
  }[] = JSON.parse(fs.readFileSync(filePath, 'utf8'));

  await runSQL('DELETE FROM holdings WHERE snapshot = $1', [snapshot]);

  let count = 0;
  for (const h of holdings) {
    await runSQL(
      `INSERT INTO holdings (fund_id, fund_name, units, purchase_date, purchase_nav, snapshot)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (fund_id, snapshot) DO UPDATE SET
         fund_name=EXCLUDED.fund_name, units=EXCLUDED.units,
         purchase_date=EXCLUDED.purchase_date, purchase_nav=EXCLUDED.purchase_nav`,
      [h.fund_id, h.fund_name, h.units, h.purchase_date, h.purchase_nav, snapshot]
    );
    count++;
  }
  console.log(`✅ Holdings: ${count} rows (${snapshot})`);
}

async function main() {
  console.log(`\n🚀 Ingesting: ${snapshot} from ${path.resolve(DATA_DIR)}\n`);
  try {
    await applySchema();
    await ingestTransactions();
    await ingestFunds();
    await ingestHoldings();
    console.log('\n✅ Ingest complete.\n');
  } catch (err) {
    console.error('❌ Ingest failed:', err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
