/**
 * Tool: query_transactions
 *
 * A single, expressive tool for all spending questions.
 * Handles filtering by category, merchant, date range, and amount,
 * plus aggregation (sum, average, count, top-N, month-over-month).
 *
 * Merchant matching is fuzzy/normalized — handles aliases automatically.
 * Transfers (category='transfer') are excluded from spending by default.
 */

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { query } from '../../db';

const inputSchema = z.object({
  snapshot: z
    .string()
    .optional()
    .describe("Dataset snapshot to query, e.g. 'sample_a'. Omit to query all loaded snapshots."),

  category: z
    .string()
    .optional()
    .describe("Filter by category, e.g. 'food', 'travel', 'subscription'. Case-insensitive."),

  merchant_search: z
    .string()
    .optional()
    .describe(
      "Partial merchant name to match. Uses normalized matching — 'swiggy' matches 'SWIGGY*ORDER', 'Swiggy Instamart', etc."
    ),

  date_from: z.string().optional().describe("Start date (inclusive) in YYYY-MM-DD format."),
  date_to: z.string().optional().describe("End date (inclusive) in YYYY-MM-DD format."),

  month: z
    .string()
    .optional()
    .describe(
      "Shorthand for a full calendar month, e.g. '2025-03' means 2025-03-01 to 2025-03-31."
    ),

  exclude_transfers: z
    .boolean()
    .optional()
    .default(true)
    .describe("Exclude internal transfers (category=transfer). Default: true."),

  exclude_refunds: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "If true, exclude negative-amount rows. Default false — refunds reduce net spend naturally."
    ),

  aggregate: z
    .enum(['net_spend', 'total_transactions', 'average', 'top_merchants', 'by_month', 'by_category', 'recurring', 'list'])
    .optional()
    .default('net_spend')
    .describe(
      "What to compute. 'net_spend'=sum of amounts (refunds auto-reduce). 'top_merchants'=ranked by net spend. 'by_month'=monthly breakdown. 'by_category'=category breakdown. 'recurring'=merchants with regular intervals. 'list'=return raw rows."
    ),

  limit: z
    .number()
    .optional()
    .default(10)
    .describe("For top_merchants or list: max rows to return. Default 10."),
});

export const queryTransactions = createTool({
  id: 'query_transactions',
  description:
    'Query and aggregate the user\'s spending transactions. Use this for ALL spending questions: totals by category or merchant, date ranges, month-over-month comparisons, top merchants, recurring subscriptions, and refund handling. Pass aggregate="by_month" for comparisons, "top_merchants" for rankings, "recurring" for subscription detection, "list" for raw transaction lookup.',
  inputSchema,
  execute: async ({ context }) => {
    const {
      snapshot,
      category,
      merchant_search,
      date_from,
      date_to,
      month,
      exclude_transfers,
      exclude_refunds,
      aggregate,
      limit,
    } = context;

    // Build WHERE clauses
    const conditions: string[] = [];
    const params: unknown[] = [];
    let p = 1;

    if (snapshot) {
      conditions.push(`snapshot = $${p++}`);
      params.push(snapshot);
    }

    if (category) {
      conditions.push(`LOWER(category) = LOWER($${p++})`);
      params.push(category);
    }

    if (merchant_search) {
      // Normalize: strip punctuation/spaces/asterisks for fuzzy matching
      conditions.push(
        `LOWER(REGEXP_REPLACE(merchant, '[^a-z0-9]', '', 'gi')) LIKE LOWER($${p++})`
      );
      const normalized = merchant_search.replace(/[^a-z0-9]/gi, '').toLowerCase();
      params.push(`%${normalized}%`);
    }

    if (month) {
      // month = '2025-03' → 2025-03-01 to 2025-03-31
      const [yr, mo] = month.split('-').map(Number);
      const lastDay = new Date(yr, mo, 0).getDate(); // day 0 of next month = last day of this
      conditions.push(`date >= $${p++} AND date <= $${p++}`);
      params.push(`${month}-01`, `${month}-${String(lastDay).padStart(2, '0')}`);
    } else {
      if (date_from) {
        conditions.push(`date >= $${p++}`);
        params.push(date_from);
      }
      if (date_to) {
        conditions.push(`date <= $${p++}`);
        params.push(date_to);
      }
    }

    if (exclude_transfers) {
      conditions.push(`LOWER(category) != 'transfer'`);
    }

    if (exclude_refunds) {
      conditions.push(`amount > 0`);
    }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    try {
      switch (aggregate) {
        case 'net_spend': {
          const rows = await query<{ total: string; count: string }>(
            `SELECT ROUND(SUM(amount)::numeric, 2) AS total, COUNT(*) AS count FROM transactions ${where}`,
            params
          );
          const total = parseFloat(rows[0]?.total ?? '0');
          const count = parseInt(rows[0]?.count ?? '0');
          return {
            net_spend_inr: total,
            transaction_count: count,
            note: total < 0 ? 'Net negative — refunds exceeded spend in this period.' : undefined,
          };
        }

        case 'total_transactions': {
          const rows = await query<{ count: string }>(
            `SELECT COUNT(*) AS count FROM transactions ${where}`,
            params
          );
          return { transaction_count: parseInt(rows[0]?.count ?? '0') };
        }

        case 'average': {
          const rows = await query<{ avg: string; count: string }>(
            `SELECT ROUND(AVG(amount)::numeric, 2) AS avg, COUNT(*) AS count FROM transactions ${where}`,
            params
          );
          return {
            average_transaction_inr: parseFloat(rows[0]?.avg ?? '0'),
            transaction_count: parseInt(rows[0]?.count ?? '0'),
          };
        }

        case 'top_merchants': {
          const rows = await query<{ merchant: string; net_spend: string; count: string }>(
            `SELECT merchant,
                    ROUND(SUM(amount)::numeric, 2) AS net_spend,
                    COUNT(*) AS count
             FROM transactions ${where}
             GROUP BY merchant
             ORDER BY SUM(amount) DESC
             LIMIT $${p++}`,
            [...params, limit ?? 10]
          );
          return {
            top_merchants: rows.map((r) => ({
              merchant: r.merchant,
              net_spend_inr: parseFloat(r.net_spend),
              transaction_count: parseInt(r.count),
            })),
          };
        }

        case 'by_month': {
          const rows = await query<{ month: string; net_spend: string; count: string }>(
            `SELECT TO_CHAR(date, 'YYYY-MM') AS month,
                    ROUND(SUM(amount)::numeric, 2) AS net_spend,
                    COUNT(*) AS count
             FROM transactions ${where}
             GROUP BY TO_CHAR(date, 'YYYY-MM')
             ORDER BY month`,
            params
          );
          return {
            monthly_breakdown: rows.map((r) => ({
              month: r.month,
              net_spend_inr: parseFloat(r.net_spend),
              transaction_count: parseInt(r.count),
            })),
          };
        }

        case 'by_category': {
          const rows = await query<{ category: string; net_spend: string; count: string }>(
            `SELECT category,
                    ROUND(SUM(amount)::numeric, 2) AS net_spend,
                    COUNT(*) AS count
             FROM transactions ${where}
             GROUP BY category
             ORDER BY SUM(amount) DESC`,
            params
          );
          return {
            category_breakdown: rows.map((r) => ({
              category: r.category,
              net_spend_inr: parseFloat(r.net_spend),
              transaction_count: parseInt(r.count),
            })),
          };
        }

        case 'recurring': {
          // Find merchants that appear in 3+ distinct months = likely recurring
          const rows = await query<{
            merchant: string;
            months_active: string;
            avg_amount: string;
            count: string;
          }>(
            `SELECT merchant,
                    COUNT(DISTINCT TO_CHAR(date, 'YYYY-MM')) AS months_active,
                    ROUND(AVG(amount)::numeric, 2) AS avg_amount,
                    COUNT(*) AS count
             FROM transactions ${where}
             GROUP BY merchant
             HAVING COUNT(DISTINCT TO_CHAR(date, 'YYYY-MM')) >= 3
             ORDER BY COUNT(DISTINCT TO_CHAR(date, 'YYYY-MM')) DESC, COUNT(*) DESC
             LIMIT $${p++}`,
            [...params, limit ?? 20]
          );
          return {
            recurring_merchants: rows.map((r) => ({
              merchant: r.merchant,
              months_active: parseInt(r.months_active),
              avg_amount_inr: parseFloat(r.avg_amount),
              total_transactions: parseInt(r.count),
            })),
          };
        }

        case 'list': {
          const rows = await query<{
            id: string;
            date: string;
            merchant: string;
            category: string;
            amount: string;
            memo: string;
          }>(
            `SELECT id, date::text, merchant, category, amount::text, memo
             FROM transactions ${where}
             ORDER BY amount DESC
             LIMIT $${p++}`,
            [...params, limit ?? 10]
          );
          return {
            transactions: rows.map((r) => ({
              id: r.id,
              date: r.date,
              merchant: r.merchant,
              category: r.category,
              amount_inr: parseFloat(r.amount),
              memo: r.memo,
            })),
          };
        }

        default:
          return { error: `Unknown aggregate type: ${aggregate}` };
      }
    } catch (err) {
      return {
        error: `Database query failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
});
