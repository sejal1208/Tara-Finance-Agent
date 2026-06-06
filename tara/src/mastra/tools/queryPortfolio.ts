/**
 * Tool: query_portfolio
 *
 * Handles all fund and holdings questions:
 * - Fund period return (NAV change between two dates — market performance)
 * - Holding realised return (user's actual profit: current value vs purchase cost)
 * - Portfolio aggregate (total current value, total cost, total gain)
 * - Fund rankings by return
 *
 * KEY DISTINCTION (enforced in tool logic):
 *   period_return  = (nav_end - nav_start) / nav_start × 100
 *                    "How did this fund perform between date A and date B?"
 *   realised_return = (current_nav × units - purchase_nav × units) / (purchase_nav × units) × 100
 *                    "How much have *I* made on my specific holding?"
 */

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { query } from '../../db';

const inputSchema = z.object({
  snapshot: z
    .string()
    .optional()
    .describe("Dataset snapshot, e.g. 'sample_a'. Omit to use the first available snapshot."),

  mode: z
    .enum(['period_return', 'realised_return', 'portfolio_summary', 'fund_rankings', 'list_holdings', 'list_funds'])
    .describe(
      "What to compute. 'period_return'=fund NAV change between two dates. 'realised_return'=user's profit on a specific holding. 'portfolio_summary'=total portfolio value and gain. 'fund_rankings'=rank all funds by period return. 'list_holdings'=show all holdings. 'list_funds'=show all available funds."
    ),

  fund_id: z
    .string()
    .optional()
    .describe("Specific fund id, e.g. 'fund_index'. Required for period_return and realised_return."),

  fund_name_search: z
    .string()
    .optional()
    .describe(
      "Partial fund name to look up fund_id automatically, e.g. 'Sentinel Nifty' or 'bluechip'."
    ),

  date_from: z
    .string()
    .optional()
    .describe("Start date (YYYY-MM-DD) for period_return or fund_rankings."),

  date_to: z
    .string()
    .optional()
    .describe("End date (YYYY-MM-DD) for period_return or fund_rankings. Defaults to latest NAV."),
});

export const queryPortfolio = createTool({
  id: 'query_portfolio',
  description:
    "Query mutual fund and holding data. Use for: fund period returns (NAV change between dates), user's realised returns on holdings (purchase cost vs current value), total portfolio worth, fund rankings, and listing what the user owns. Always pick mode carefully — 'period_return' answers 'how did fund X perform from A to B?', 'realised_return' answers 'how much have I made on fund X since I bought it?'.",
  inputSchema,
  execute: async ({ context }) => {
    const { snapshot, mode, fund_id, fund_name_search, date_from, date_to } = context;

    // Resolve snapshot
    let snap = snapshot;
    if (!snap) {
      const snaps = await query<{ snapshot: string }>(
        `SELECT DISTINCT snapshot FROM funds LIMIT 1`
      );
      snap = snaps[0]?.snapshot;
      if (!snap) return { error: 'No fund data found in database. Run ingest first.' };
    }

    // Resolve fund_id from name search if needed
    let resolvedFundId = fund_id;
    if (!resolvedFundId && fund_name_search) {
      const found = await query<{ id: string; name: string }>(
        `SELECT id, name FROM funds
         WHERE snapshot = $1 AND LOWER(name) LIKE LOWER($2)
         LIMIT 1`,
        [snap, `%${fund_name_search}%`]
      );
      if (!found.length) {
        return { error: `No fund matching '${fund_name_search}' found in snapshot '${snap}'.` };
      }
      resolvedFundId = found[0].id;
    }

    try {
      switch (mode) {
        case 'period_return': {
          if (!resolvedFundId) {
            return { error: 'fund_id or fund_name_search is required for period_return.' };
          }

          // Get NAV at start and end dates (use closest available date on or before)
          const navQuery = async (date: string) => {
            const rows = await query<{ nav_value: string; nav_date: string }>(
              `SELECT nav_value, nav_date::text FROM fund_nav
               WHERE fund_id = $1 AND snapshot = $2 AND nav_date <= $3
               ORDER BY nav_date DESC LIMIT 1`,
              [resolvedFundId, snap, date]
            );
            return rows[0] ?? null;
          };

          const latestNav = await query<{ nav_value: string; nav_date: string }>(
            `SELECT nav_value, nav_date::text FROM fund_nav
             WHERE fund_id = $1 AND snapshot = $2
             ORDER BY nav_date DESC LIMIT 1`,
            [resolvedFundId, snap]
          );

          const endDate = date_to || latestNav[0]?.nav_date;
          if (!endDate) return { error: `No NAV data found for fund ${resolvedFundId}.` };

          const startDate = date_from;
          if (!startDate) {
            return { error: 'date_from is required for period_return.' };
          }

          const [startNav, endNav] = await Promise.all([navQuery(startDate), navQuery(endDate)]);

          if (!startNav)
            return { error: `No NAV data found on or before ${startDate} for ${resolvedFundId}.` };
          if (!endNav)
            return { error: `No NAV data found on or before ${endDate} for ${resolvedFundId}.` };

          const navStart = parseFloat(startNav.nav_value);
          const navEnd = parseFloat(endNav.nav_value);
          const returnPct = ((navEnd - navStart) / navStart) * 100;

          // Get fund name
          const fundInfo = await query<{ name: string }>(
            `SELECT name FROM funds WHERE id = $1 AND snapshot = $2`,
            [resolvedFundId, snap]
          );

          return {
            type: 'period_return',
            fund_id: resolvedFundId,
            fund_name: fundInfo[0]?.name ?? resolvedFundId,
            nav_start: navStart,
            nav_start_date: startNav.nav_date,
            nav_end: navEnd,
            nav_end_date: endNav.nav_date,
            period_return_pct: Math.round(returnPct * 100) / 100,
            note: "This is the fund's market return for the period, independent of when the user bought it.",
          };
        }

        case 'realised_return': {
          if (!resolvedFundId) {
            return { error: 'fund_id or fund_name_search is required for realised_return.' };
          }

          const holding = await query<{
            fund_name: string;
            units: string;
            purchase_date: string;
            purchase_nav: string;
          }>(
            `SELECT fund_name, units, purchase_date::text, purchase_nav
             FROM holdings WHERE fund_id = $1 AND snapshot = $2`,
            [resolvedFundId, snap]
          );

          if (!holding.length) {
            return {
              error: `No holding found for fund_id '${resolvedFundId}' in snapshot '${snap}'. The user may not own this fund.`,
            };
          }

          const h = holding[0];
          const units = parseFloat(h.units);
          const purchaseNav = parseFloat(h.purchase_nav);
          const purchaseCost = units * purchaseNav;

          // Current NAV = latest available
          const currentNavRow = await query<{ nav_value: string; nav_date: string }>(
            `SELECT nav_value, nav_date::text FROM fund_nav
             WHERE fund_id = $1 AND snapshot = $2
             ORDER BY nav_date DESC LIMIT 1`,
            [resolvedFundId, snap]
          );

          if (!currentNavRow.length) {
            return { error: `No NAV data found for fund ${resolvedFundId}.` };
          }

          const currentNav = parseFloat(currentNavRow[0].nav_value);
          const currentValue = units * currentNav;
          const absoluteGain = currentValue - purchaseCost;
          const returnPct = (absoluteGain / purchaseCost) * 100;

          return {
            type: 'realised_return',
            fund_id: resolvedFundId,
            fund_name: h.fund_name,
            units,
            purchase_date: h.purchase_date,
            purchase_nav: purchaseNav,
            purchase_cost_inr: Math.round(purchaseCost * 100) / 100,
            current_nav: currentNav,
            current_nav_date: currentNavRow[0].nav_date,
            current_value_inr: Math.round(currentValue * 100) / 100,
            absolute_gain_inr: Math.round(absoluteGain * 100) / 100,
            realised_return_pct: Math.round(returnPct * 100) / 100,
            note: "This is the user's actual return based on their purchase price and units owned.",
          };
        }

        case 'portfolio_summary': {
          const holdings = await query<{
            fund_id: string;
            fund_name: string;
            units: string;
            purchase_nav: string;
          }>(
            `SELECT fund_id, fund_name, units, purchase_nav FROM holdings WHERE snapshot = $1`,
            [snap]
          );

          if (!holdings.length) {
            return { error: `No holdings found in snapshot '${snap}'.` };
          }

          let totalCost = 0;
          let totalCurrentValue = 0;
          const positions: object[] = [];

          for (const h of holdings) {
            const units = parseFloat(h.units);
            const purchaseNav = parseFloat(h.purchase_nav);
            const cost = units * purchaseNav;

            const currentNavRow = await query<{ nav_value: string; nav_date: string }>(
              `SELECT nav_value, nav_date::text FROM fund_nav
               WHERE fund_id = $1 AND snapshot = $2
               ORDER BY nav_date DESC LIMIT 1`,
              [h.fund_id, snap]
            );

            const currentNav = currentNavRow.length
              ? parseFloat(currentNavRow[0].nav_value)
              : purchaseNav;
            const currentValue = units * currentNav;
            const gain = currentValue - cost;

            totalCost += cost;
            totalCurrentValue += currentValue;

            positions.push({
              fund_name: h.fund_name,
              units,
              purchase_nav: purchaseNav,
              current_nav: currentNav,
              current_value_inr: Math.round(currentValue * 100) / 100,
              gain_inr: Math.round(gain * 100) / 100,
              return_pct: Math.round(((gain / cost) * 100) * 100) / 100,
            });
          }

          const totalGain = totalCurrentValue - totalCost;
          const overallReturn = (totalGain / totalCost) * 100;

          return {
            type: 'portfolio_summary',
            total_invested_inr: Math.round(totalCost * 100) / 100,
            total_current_value_inr: Math.round(totalCurrentValue * 100) / 100,
            total_gain_inr: Math.round(totalGain * 100) / 100,
            overall_return_pct: Math.round(overallReturn * 100) / 100,
            positions,
          };
        }

        case 'fund_rankings': {
          const endDate = date_to;
          const startDate = date_from;
          if (!startDate || !endDate) {
            return { error: 'date_from and date_to are required for fund_rankings.' };
          }

          const funds = await query<{ id: string; name: string; category: string }>(
            `SELECT id, name, category FROM funds WHERE snapshot = $1`,
            [snap]
          );

          const results: {
            fund_id: string;
            fund_name: string;
            category: string;
            nav_start: number;
            nav_end: number;
            period_return_pct: number;
          }[] = [];

          for (const fund of funds) {
            const startNavRow = await query<{ nav_value: string }>(
              `SELECT nav_value FROM fund_nav
               WHERE fund_id = $1 AND snapshot = $2 AND nav_date <= $3
               ORDER BY nav_date DESC LIMIT 1`,
              [fund.id, snap, startDate]
            );
            const endNavRow = await query<{ nav_value: string }>(
              `SELECT nav_value FROM fund_nav
               WHERE fund_id = $1 AND snapshot = $2 AND nav_date <= $3
               ORDER BY nav_date DESC LIMIT 1`,
              [fund.id, snap, endDate]
            );

            if (!startNavRow.length || !endNavRow.length) continue;

            const navStart = parseFloat(startNavRow[0].nav_value);
            const navEnd = parseFloat(endNavRow[0].nav_value);
            const ret = ((navEnd - navStart) / navStart) * 100;

            results.push({
              fund_id: fund.id,
              fund_name: fund.name,
              category: fund.category,
              nav_start: navStart,
              nav_end: navEnd,
              period_return_pct: Math.round(ret * 100) / 100,
            });
          }

          results.sort((a, b) => b.period_return_pct - a.period_return_pct);

          const best = results[0];
          const worst = results[results.length - 1];
          const spread =
            best && worst
              ? Math.round((best.period_return_pct - worst.period_return_pct) * 100) / 100
              : null;

          return {
            type: 'fund_rankings',
            period: { from: startDate, to: endDate },
            rankings: results,
            best_fund: best?.fund_name,
            worst_fund: worst?.fund_name,
            spread_pct: spread,
          };
        }

        case 'list_holdings': {
          const rows = await query<{
            fund_id: string;
            fund_name: string;
            units: string;
            purchase_date: string;
            purchase_nav: string;
          }>(
            `SELECT fund_id, fund_name, units, purchase_date::text, purchase_nav
             FROM holdings WHERE snapshot = $1 ORDER BY fund_name`,
            [snap]
          );
          return {
            holdings: rows.map((r) => ({
              fund_id: r.fund_id,
              fund_name: r.fund_name,
              units: parseFloat(r.units),
              purchase_date: r.purchase_date,
              purchase_nav: parseFloat(r.purchase_nav),
            })),
          };
        }

        case 'list_funds': {
          const rows = await query<{ id: string; name: string; category: string }>(
            `SELECT id, name, category FROM funds WHERE snapshot = $1 ORDER BY name`,
            [snap]
          );
          return {
            funds: rows.map((r) => ({
              fund_id: r.id,
              fund_name: r.name,
              category: r.category,
            })),
          };
        }

        default:
          return { error: `Unknown mode: ${mode}` };
      }
    } catch (err) {
      return {
        error: `Database query failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
});
