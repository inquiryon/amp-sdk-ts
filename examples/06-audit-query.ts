// Audit-history query: the complete, append-only event trail for one
// governed request. Fictional data only.
import { agentClient, ensurePolicy, newRequestId, reviewerClient } from './_shared.js';

async function main() {
  await ensurePolicy();
  const agent = agentClient();
  const reviewer = reviewerClient();

  const submitted = await agent.submitGovernedRequest({
    policyId: 'invoice-governance', tool: 'pay_invoice', action: 'submit',
    params: { amount: 5000 }, requestId: newRequestId('audit'),
  });
  await reviewer.approve(submitted.hitl_id as string, { note: 'ok to pay' });

  const { items } = await reviewer.listAuditEvents({ requestId: submitted.request_id });
  for (const event of items) {
    console.log(`${event.occurred_at}  ${event.event_type.padEnd(20)} actor=${event.actor}`);
  }
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
