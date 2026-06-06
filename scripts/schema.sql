-- Tara Finance Agent — Postgres Schema
-- Run once before ingesting: psql $DATABASE_URL -f scripts/schema.sql

CREATE TABLE IF NOT EXISTS transactions (
  id           TEXT PRIMARY KEY,
  date         DATE NOT NULL,
  merchant     TEXT NOT NULL,
  category     TEXT NOT NULL DEFAULT 'uncategorized',
  amount       NUMERIC(12, 2) NOT NULL,   -- negative = refund/reversal
  currency     TEXT NOT NULL DEFAULT 'INR',
  memo         TEXT,
  snapshot     TEXT NOT NULL              -- which data folder this came from
);

CREATE TABLE IF NOT EXISTS funds (
  id           TEXT NOT NULL,
  name         TEXT NOT NULL,
  category     TEXT NOT NULL,
  snapshot     TEXT NOT NULL,
  PRIMARY KEY (id, snapshot)
);

CREATE TABLE IF NOT EXISTS fund_nav (
  fund_id      TEXT NOT NULL,
  snapshot     TEXT NOT NULL,
  nav_date     DATE NOT NULL,
  nav_value    NUMERIC(12, 4) NOT NULL,
  PRIMARY KEY (fund_id, snapshot, nav_date)
);

CREATE TABLE IF NOT EXISTS holdings (
  fund_id        TEXT NOT NULL,
  fund_name      TEXT NOT NULL,
  units          NUMERIC(16, 6) NOT NULL,
  purchase_date  DATE NOT NULL,
  purchase_nav   NUMERIC(12, 4) NOT NULL,
  snapshot       TEXT NOT NULL,
  PRIMARY KEY (fund_id, snapshot)
);

-- Indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_txn_date       ON transactions (date);
CREATE INDEX IF NOT EXISTS idx_txn_category   ON transactions (category);
CREATE INDEX IF NOT EXISTS idx_txn_merchant   ON transactions (merchant);
CREATE INDEX IF NOT EXISTS idx_txn_amount     ON transactions (amount);
CREATE INDEX IF NOT EXISTS idx_txn_snapshot   ON transactions (snapshot);
CREATE INDEX IF NOT EXISTS idx_nav_fund_date  ON fund_nav (fund_id, snapshot, nav_date);
CREATE INDEX IF NOT EXISTS idx_holdings_snap  ON holdings (snapshot);
