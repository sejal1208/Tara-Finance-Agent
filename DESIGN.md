# DESIGN.md — Tara Finance Research Agent

## Postgres Schema

### Tables

**`transactions`**
| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | Original ID from JSON, unique per transaction |
| `date` | DATE | Indexed for range queries |
| `merchant` | TEXT | Raw string from source — aliases resolved at query time |
| `category` | TEXT | 'uncategorized' when missing |
| `amount` | NUMERIC(12,2) | Negative = refund/reversal |
| `currency` | TEXT | 'INR' default |
| `memo` | TEXT | Untrusted free text; never parsed for logic |
| `snapshot` | TEXT | Which data folder this row came from |

**`funds`**
| Column | Type | Notes |
|---|---|---|
| `id` | TEXT | Fund identifier |
| `name` | TEXT | Display name |
| `category` | TEXT | e.g. 'large_cap', 'debt' |
| `snapshot` | TEXT | Source snapshot |
| PK | (id, snapshot) | Same fund_id can appear in multiple snapshots |

**`fund_nav`**
| Column | Type | Notes |
|---|---|---|
| `fund_id` | TEXT | FK → funds |
| `snapshot` | TEXT | Source snapshot |
| `nav_date` | DATE | First day of month |
| `nav_value` | NUMERIC(12,4) | NAV on that date |
| PK | (fund_id, snapshot, nav_date) | |

**`holdings`**
| Column | Type | Notes |
|---|---|---|
| `fund_id` | TEXT | FK → funds |
| `fund_name` | TEXT | Denormalized for readability |
| `units` | NUMERIC(16,6) | Units owned by user |
| `purchase_date` | DATE | When user bought |
| `purchase_nav` | NUMERIC(12,4) | NAV at time of purchase |
| `snapshot` | TEXT | Source snapshot |
| PK | (fund_id, snapshot) | |

### Indexes

```sql
idx_txn_date       ON transactions(date)
idx_txn_category   ON transactions(category)
idx_txn_merchant   ON transactions(merchant)
idx_txn_amount     ON transactions(amount)
idx_txn_snapshot   ON transactions(snapshot)
idx_nav_fund_date  ON fund_nav(fund_id, snapshot, nav_date)
idx_holdings_snap  ON holdings(snapshot)
```

Date, category, and merchant are the three main filter axes in `query_transactions`. The `fund_nav` index covers the most common lookup: "find the NAV closest to date X for fund Y."

### Why `snapshot` as a column?

All three sample datasets are ingested into the same tables. `snapshot` allows the grader to run `DATA_DIR=./data/sample_x npx tsx scripts/ingest.ts` repeatedly without wiping data from other snapshots. It also makes cross-snapshot queries possible if needed.

---

## Tool Design

### Two tools vs. many narrow ones

Following the assignment's guidance, I chose two expressive tools over many narrow ones:

**`query_transactions`** handles all spending questions via a single SQL-backed function with parameter-driven dispatch. One `aggregate` parameter selects the computation mode: `net_spend`, `top_merchants`, `by_month`, `by_category`, `recurring`, `list`. This means the model only needs to learn one tool shape, reducing selection errors and token cost.

**`query_portfolio`** handles all fund/holdings questions via a `mode` parameter: `period_return`, `realised_return`, `portfolio_summary`, `fund_rankings`, `list_holdings`, `list_funds`.

The alternative (6-10 narrow tools) would have bloated the model's context on every turn and increased the probability of the model calling the wrong tool for an edge-case question.

---

## Grounding Guarantee

Every number Tara states comes directly from a tool result. The agent system prompt enforces this explicitly:

> "NEVER state a number that did not come directly from a tool result. If you don't have the number from a tool, call the tool."

Tools return structured JSON with explicit field names (`net_spend_inr`, `period_return_pct`, etc.) — never raw rows that the model would need to mentally aggregate. All arithmetic happens in SQL or TypeScript; the model only formats the result into prose.

---

## Key Formulas

### Net spend
```
net_spend = SUM(amount) WHERE category != 'transfer' AND date BETWEEN date_from AND date_to
```
Negative amounts (refunds) naturally reduce this sum. No special handling needed — they're just negative rows.

### Merchant matching (alias resolution)
```sql
LOWER(REGEXP_REPLACE(merchant, '[^a-z0-9]', '', 'gi')) LIKE LOWER('%<normalized_search>%')
```
Both the stored merchant name and the search term are stripped of punctuation, asterisks, spaces, and special characters before comparison. `SWIGGY*ORDER`, `Swiggy Instamart`, `SWIGGY BANGALORE` all normalize to contain `swiggy`, so a search for "swiggy" matches all of them. No hardcoded alias lists needed.

### Recurring detection
```sql
merchants WHERE COUNT(DISTINCT YYYY-MM) >= 3
```
Merchants appearing in 3+ distinct calendar months are flagged as likely recurring. This is a heuristic — it correctly catches monthly subscriptions (Netflix, Spotify, etc.) while ignoring one-time purchases and occasional merchants.

### Fund period return
```
period_return_pct = (nav_end - nav_start) / nav_start × 100
```
`nav_start` = closest NAV on or before `date_from`.
`nav_end` = closest NAV on or before `date_to` (defaults to latest available).

This is the fund's **market performance** for the period, independent of who owns it or when they bought it.

### Holding realised return
```
purchase_cost = units × purchase_nav
current_value = units × current_nav   (current_nav = latest available NAV)
absolute_gain = current_value - purchase_cost
realised_return_pct = absolute_gain / purchase_cost × 100
```
This is the **user's actual profit** based on their specific purchase price and unit count. It will differ from the fund's period return whenever the user's purchase date doesn't align with the return window start.

---

## Eval Suite

15 questions covering:
- Single category total (E01)
- Single month filter (E02)
- Q1 2025 total excluding transfers (E03)
- Refund handling — net spend after refunds (E04)
- Merchant alias resolution — Swiggy variants (E05)
- Transfer exclusion (E06)
- Month-over-month category comparison (E07)
- Top 5 merchants by net spend (E08)
- Recurring subscription detection (E09)
- Honest no-data response for non-existent period (E10)
- Fund period return between two dates (E11)
- Fund rankings with spread (E12)
- Realised return on a specific holding (E13)
- Portfolio total worth and absolute gain (E14)
- Biggest single expense (E15)

Pass criteria: each case checks for expected phrases and/or presence of numeric values in the answer. The no-data case (E10) checks that the model does NOT return "₹0" or "zero" but explicitly states no data was found.

---

## Observability

Each `POST /ask` request produces a structured JSON log line in `logs/requests.jsonl`:
```json
{
  "request_id": "req_1717000000_abc123",
  "question": "How much did I spend on food in March 2025?",
  "timestamp": "2025-06-06T10:00:00.000Z",
  "tools_called": ["query_transactions"],
  "status": "success",
  "latency_ms": 1840,
  "answer_length": 142
}
```

To inspect a failed run:
```bash
cat logs/requests.jsonl | python3 -c "
import sys, json
for line in sys.stdin:
    entry = json.loads(line)
    if entry.get('status') == 'error':
        print(json.dumps(entry, indent=2))
"
```

---

## Async Milestone

Not implemented. All tools run synchronously. For a production system, the portfolio summary tool (which queries NAV for every holding in a loop) is the main candidate for async execution since it makes N database round trips. With more time I would:
1. Move `portfolio_summary` to a BullMQ worker
2. Have the tool return `{ job_id, status: "running" }` immediately
3. Poll or use Server-Sent Events to deliver the final answer

---

## Deployment

Deployed on Render (Web Service + Postgres). Free tier with the following tradeoffs:
- Cold start ~20-30s after 15 min inactivity
- 1GB Postgres storage (well within limits for this dataset)
- No horizontal scaling (single dyno)

---

## Known Failure Modes

1. **Relative date ambiguity**: "last month" is resolved as the month before the latest transaction date (2025-03), so "last month" = February 2025. If a fresh snapshot has a different date range, this assumption may be wrong. Mitigation: the agent states its date assumption in answers.

2. **Merchant aliases on unseen data**: The fuzzy matching (strip non-alphanumeric, substring match) handles most aliases but could false-positive if two unrelated merchants share a short substring. A more robust approach would use edit-distance clustering — but that requires an extra pass at ingest time.

3. **Non-deterministic tool selection**: The model may choose different tools on repeated runs for ambiguous questions. The agent instructions and tool descriptions are tuned to minimize this, but Gemini is non-deterministic.

4. **Large portfolio queries**: The `portfolio_summary` mode makes one DB query per holding in a loop. With 8 holdings this is fast (~8 queries); with 50+ holdings it would be slow. Should be batched with a single JOIN query in production.

5. **Missing NAV dates**: When a user asks for a return at a date between monthly NAV points, we use the closest NAV on or before the requested date. This is the standard approach but introduces slight imprecision for intra-month queries.
