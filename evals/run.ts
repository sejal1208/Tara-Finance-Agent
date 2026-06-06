/**
 * Eval script — sends questions to POST /ask and checks answers.
 *
 * Usage:
 *   npx tsx evals/run.ts
 *
 * Set ASK_URL env var to point at a different host (default: http://localhost:3000).
 * Set SNAPSHOT env var to indicate which dataset was ingested (default: sample_a).
 */

const ASK_URL = (process.env.ASK_URL || 'http://localhost:3000') + '/ask';
const SNAPSHOT = process.env.SNAPSHOT || 'sample_a';

interface EvalCase {
  id: string;
  question: string;
  // One or more strings that MUST appear in the answer (case-insensitive)
  must_contain?: string[];
  // Strings that must NOT appear
  must_not_contain?: string[];
  // If true, answer must parse as a number somewhere
  expect_number?: boolean;
  // Custom description of what we're testing
  description: string;
}

const EVAL_CASES: EvalCase[] = [
  // ── Single lookup ──
  {
    id: 'E01',
    description: 'Single category total — food spend',
    question: 'How much did I spend on food in total?',
    must_contain: ['₹', 'food'],
    expect_number: true,
  },
  {
    id: 'E02',
    description: 'Single month filter',
    question: 'How much did I spend on food in March 2025?',
    must_contain: ['March', '2025'],
    expect_number: true,
  },

  // ── Date filtering ──
  {
    id: 'E03',
    description: 'Q1 2025 total spend excluding transfers',
    question: 'What was my total spending in Q1 2025, excluding transfers?',
    must_contain: ['2025'],
    must_not_contain: ['transfer'],
    expect_number: true,
  },

  // ── Refunds ──
  {
    id: 'E04',
    description: 'Refunds reduce net spend',
    question: 'How much did I spend on food in March 2025 after refunds?',
    must_contain: ['March', '2025'],
    expect_number: true,
  },

  // ── Merchant alias ──
  {
    id: 'E05',
    description: 'Merchant alias resolution — Swiggy variants',
    question: 'How much did I spend on Swiggy in total, including all Swiggy variants?',
    must_contain: ['Swiggy'],
    expect_number: true,
  },

  // ── Transfers exclusion ──
  {
    id: 'E06',
    description: 'Transfers excluded from spending',
    question: 'Ignore transfers. What was my actual total spending in 2024?',
    must_contain: ['2024'],
    expect_number: true,
  },

  // ── Category comparison ──
  {
    id: 'E07',
    description: 'Month-over-month category comparison',
    question:
      'Compare my food and travel spending month by month from January to March 2025. Which grew faster?',
    must_contain: ['food', 'travel'],
    expect_number: true,
  },

  // ── Top merchants ──
  {
    id: 'E08',
    description: 'Top 5 merchants by net spend',
    question: 'What were my top 5 merchants by total spending between January and March 2025?',
    must_contain: ['1.', '2.'],
    expect_number: true,
  },

  // ── Recurring subscriptions ──
  {
    id: 'E09',
    description: 'Recurring subscription detection',
    question: 'Which merchants look like recurring subscriptions?',
    must_contain: ['Netflix', 'Spotify'],
  },

  // ── No-data case ──
  {
    id: 'E10',
    description: 'Honest no-data response for future month',
    question: 'Do I have any spending data for December 2030?',
    must_contain: ['no data', 'not found', "don't have", 'no transactions', 'no spending'],
    must_not_contain: ['₹0', 'zero'],
  },

  // ── Fund period return ──
  {
    id: 'E11',
    description: 'Fund period return between two dates',
    question:
      'What was the period return of my largest fund (by name) from 2024-01-01 to 2025-01-01?',
    expect_number: true,
  },

  // ── Fund rankings ──
  {
    id: 'E12',
    description: 'Fund rankings by 1-year return',
    question:
      'Rank all my funds by one-year return from 2024-01-01 to 2025-01-01, and show the spread between best and worst.',
    must_contain: ['1.', '2.', 'spread'],
    expect_number: true,
  },

  // ── Realised return on holding ──
  {
    id: 'E13',
    description: 'Realised return on a specific holding',
    question:
      'What is my realised return on the Sentinel Nifty Index Fund holding, based on when I bought it?',
    must_contain: ['Sentinel', 'Nifty', 'return'],
    expect_number: true,
  },

  // ── Portfolio aggregate ──
  {
    id: 'E14',
    description: 'Total portfolio worth and gain',
    question:
      'What is my total portfolio worth today, and how much have I made on it in absolute INR?',
    must_contain: ['portfolio', '₹', 'gain', 'return'],
    expect_number: true,
  },

  // ── Biggest single expense ──
  {
    id: 'E15',
    description: 'Single biggest expense',
    question: 'What was my single biggest expense?',
    expect_number: true,
  },
];

async function ask(question: string): Promise<string> {
  const res = await fetch(ASK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  const data = (await res.json()) as { answer?: string; error?: string };
  if (data.error) throw new Error(data.error);
  return data.answer || '';
}

function checkCase(answer: string, ev: EvalCase): { pass: boolean; failures: string[] } {
  const lower = answer.toLowerCase();
  const failures: string[] = [];

  if (ev.must_contain) {
    for (const phrase of ev.must_contain) {
      if (!lower.includes(phrase.toLowerCase())) {
        failures.push(`Missing expected phrase: "${phrase}"`);
      }
    }
  }

  if (ev.must_not_contain) {
    for (const phrase of ev.must_not_contain) {
      if (lower.includes(phrase.toLowerCase())) {
        failures.push(`Should not contain: "${phrase}"`);
      }
    }
  }

  if (ev.expect_number) {
    if (!/[\d,]+\.?\d*/.test(answer)) {
      failures.push('Expected a number in the answer');
    }
  }

  return { pass: failures.length === 0, failures };
}

async function runEvals() {
  console.log(`\n🧪 Tara Eval Suite`);
  console.log(`   URL: ${ASK_URL}`);
  console.log(`   Snapshot: ${SNAPSHOT}`);
  console.log(`   Cases: ${EVAL_CASES.length}\n`);
  console.log('─'.repeat(80));

  let passed = 0;
  let failed = 0;
  const failedCases: { id: string; description: string; answer: string; failures: string[] }[] =
    [];

  for (const ev of EVAL_CASES) {
    process.stdout.write(`[${ev.id}] ${ev.description}... `);
    try {
      const answer = await ask(ev.question);
      const { pass, failures } = checkCase(answer, ev);

      if (pass) {
        console.log('✅ PASS');
        passed++;
      } else {
        console.log('❌ FAIL');
        failed++;
        failedCases.push({ id: ev.id, description: ev.description, answer, failures });
      }
    } catch (err) {
      console.log(`❌ ERROR: ${err instanceof Error ? err.message : String(err)}`);
      failed++;
      failedCases.push({
        id: ev.id,
        description: ev.description,
        answer: '',
        failures: [`Request error: ${err instanceof Error ? err.message : String(err)}`],
      });
    }
  }

  console.log('\n' + '─'.repeat(80));
  console.log(`\n📊 Results: ${passed} passed / ${failed} failed / ${EVAL_CASES.length} total\n`);

  if (failedCases.length > 0) {
    console.log('❌ Failed cases:\n');
    for (const fc of failedCases) {
      console.log(`  [${fc.id}] ${fc.description}`);
      for (const f of fc.failures) {
        console.log(`    → ${f}`);
      }
      if (fc.answer) {
        console.log(`    Answer: ${fc.answer.substring(0, 200)}...`);
      }
      console.log();
    }
  }

  process.exit(failed > 0 ? 1 : 0);
}

runEvals();
