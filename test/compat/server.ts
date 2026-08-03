/**
 * Spawns a REAL amp-community server as a child process for the shared
 * live compatibility scenarios. Not a mock — this is the same server the
 * Python SDK's compat suite talks to.
 *
 * Requires a Python interpreter with amp-core and amp-community
 * installed. Resolution order: $AMP_COMMUNITY_PYTHON, then `python3` on
 * PATH. Tests using this helper skip cleanly (not fail) when spawning or
 * the health check fails, so the unit suite never depends on this.
 */
import { spawn, ChildProcessByStdio } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import type { Policy } from '../../src/models.js';

export const REVIEWER_TOKEN = 'fictional-reviewer-token-0001';
export const AGENT_TOKEN = 'fictional-agent-token-0001';
export const VIEWER_TOKEN = 'fictional-viewer-token-0001';

export const INVOICE_POLICY: Policy = {
  policy_id: 'invoice-governance',
  schema_version: 'v0',
  action_governance: {
    criteria: [{
      criterion_id: 'c-high-amount', tool: 'pay_invoice', action: '*',
      hardness: 'hard',
      evaluator: { type: 'compute', formula: 'amount > 1000' },
    }],
  },
};

export interface CompatServer {
  baseUrl: string;
  stop: () => void;
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

async function waitForHealth(baseUrl: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) return;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`amp-community server did not become healthy in time: ${lastErr}`);
}

/**
 * Returns null (not a thrown error) when the server cannot be started, so
 * callers can skip the whole compat suite cleanly.
 */
export async function startCompatServer(): Promise<CompatServer | null> {
  const pythonBin = process.env.AMP_COMMUNITY_PYTHON || 'python3';
  const required = process.env.AMP_COMPAT_REQUIRED === '1';
  const dir = mkdtempSync(join(tmpdir(), 'amp-sdk-ts-compat-'));
  const dbPath = join(dir, 'amp.db');
  const policyDir = join(dir, 'policies');
  const port = await findFreePort();
  const config = {
    db_path: dbPath,
    policy_dir: policyDir,
    bind: '127.0.0.1',
    port,
    callback: { mode: 'poll' },
    tokens: [
      { token: REVIEWER_TOKEN, principal: 'alice', role: 'reviewer' },
      { token: AGENT_TOKEN, principal: 'agent:invoice-agent', role: 'service' },
      { token: VIEWER_TOKEN, principal: 'victor', role: 'viewer' },
    ],
  };
  const configPath = join(dir, 'config.json');
  writeFileSync(configPath, JSON.stringify(config));

  let child: ChildProcessByStdio<null, Readable, Readable>;
  try {
    child = spawn(pythonBin, ['-m', 'amp_community.api', '--config', configPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    if (required) throw err;
    console.warn(`[compat] failed to spawn ${pythonBin}: ${err}`);
    return null;
  }

  const baseUrl = `http://127.0.0.1:${port}`;
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });

  const exited = new Promise<number | null>((resolve) => {
    child.once('exit', (code) => resolve(code));
  });

  try {
    await Promise.race([
      waitForHealth(baseUrl),
      exited.then((code) => { throw new Error(`server process exited early (code ${code}): ${stderr}`); }),
    ]);
  } catch (err) {
    try { child.kill(); } catch { /* ignore */ }
    if (required) throw err;
    console.warn(`[compat] amp-community did not become healthy: ${err}`);
    return null;
  }

  return {
    baseUrl,
    stop: () => { try { child.kill(); } catch { /* ignore */ } },
  };
}
