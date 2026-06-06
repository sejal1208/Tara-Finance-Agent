import 'dotenv/config';
import express from 'express';
import { taraAgent } from '../mastra/agents/tara';
import fs from 'fs';
import path from 'path';

const app = express();
app.use(express.json());

const PORT = parseInt(process.env.PORT || '3000', 10);
const LOG_FILE = process.env.LOG_FILE || './logs/requests.jsonl';

// Ensure log directory exists
const logDir = path.dirname(LOG_FILE);
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

function writeLog(entry: object) {
  try {
    fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n');
  } catch {
    // Non-fatal — don't let log failures crash the server
  }
}

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'tara-finance-agent' });
});

// Main endpoint
app.post('/ask', async (req, res) => {
  const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const startTime = Date.now();

  const question: string = req.body?.question;

  if (!question || typeof question !== 'string' || question.trim().length === 0) {
    return res.status(400).json({ error: 'Missing or empty "question" field.' });
  }

  const logEntry: Record<string, unknown> = {
    request_id: requestId,
    question: question.trim(),
    timestamp: new Date().toISOString(),
    tools_called: [] as string[],
    status: 'pending',
  };

  try {
    console.log(`[${requestId}] Q: ${question.substring(0, 120)}`);

    const result = await taraAgent.generate(question.trim(), {
      onStepFinish: (step: { toolCalls?: { toolName?: string; args?: unknown }[] }) => {
        if (step.toolCalls && step.toolCalls.length > 0) {
          for (const tc of step.toolCalls) {
            // Sanitize: never log sensitive fields
            const safeArgs = tc.args ? sanitizeArgs(tc.args as Record<string, unknown>) : {};
            (logEntry.tools_called as string[]).push(tc.toolName || 'unknown');
            console.log(
              `[${requestId}] Tool: ${tc.toolName} args=${JSON.stringify(safeArgs)}`
            );
          }
        }
      },
    });

    const answer = result.text || 'I was unable to generate an answer.';
    const latency = Date.now() - startTime;

    logEntry.status = 'success';
    logEntry.latency_ms = latency;
    logEntry.answer_length = answer.length;
    writeLog(logEntry);

    console.log(`[${requestId}] ✅ Done in ${latency}ms`);

    return res.json({ answer });
  } catch (err) {
    const latency = Date.now() - startTime;
    const errorMsg = err instanceof Error ? err.message : String(err);

    logEntry.status = 'error';
    logEntry.error = errorMsg;
    logEntry.latency_ms = latency;
    writeLog(logEntry);

    console.error(`[${requestId}] ❌ Error: ${errorMsg}`);

    return res.status(500).json({
      error: 'Tara encountered an error processing your question.',
      details: errorMsg,
    });
  }
});

function sanitizeArgs(args: Record<string, unknown>): Record<string, unknown> {
  // Remove any fields that might contain sensitive data
  const safe = { ...args };
  for (const key of ['apiKey', 'api_key', 'password', 'secret', 'token']) {
    if (key in safe) safe[key] = '[REDACTED]';
  }
  return safe;
}

app.listen(PORT, () => {
  console.log(`\n🚀 Tara is running on http://localhost:${PORT}`);
  console.log(`   POST /ask  — ask a finance question`);
  console.log(`   GET  /health — health check`);
  console.log(`   Logs: ${LOG_FILE}\n`);
});

export { app };
