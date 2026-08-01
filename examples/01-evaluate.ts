// Basic policy evaluation: dry-run a tool call against a policy without
// creating a request or review. Fictional data only.
import { ensurePolicy, reviewerClient } from './_shared.js';

async function main() {
  await ensurePolicy();
  const client = reviewerClient();

  const allowed = await client.evaluate('invoice-governance', {
    tool: 'pay_invoice', action: 'submit', params: { amount: 40 },
  });
  console.log('amount=40  ->', allowed.decision, allowed.reason);

  const blocked = await client.evaluate('invoice-governance', {
    tool: 'pay_invoice', action: 'submit', params: { amount: 5000 },
  });
  console.log('amount=5000 ->', blocked.decision, blocked.reason,
    'triggered:', blocked.triggered_criteria);
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
