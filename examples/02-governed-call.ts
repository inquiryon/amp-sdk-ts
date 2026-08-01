// A governed tool call: the agent submits, and either gets an immediate
// decision or a pending review depending on policy. Fictional data only.
import { agentClient, ensurePolicy, newRequestId } from './_shared.js';

async function main() {
  await ensurePolicy();
  const agent = agentClient();

  const small = await agent.submitGovernedRequest({
    policyId: 'invoice-governance', tool: 'pay_invoice', action: 'submit',
    params: { amount: 40 }, requestId: newRequestId('small'),
  });
  console.log('small invoice:', small.status); // "allowed" — safe to execute immediately

  const large = await agent.submitGovernedRequest({
    policyId: 'invoice-governance', tool: 'pay_invoice', action: 'submit',
    params: { amount: 5000 }, requestId: newRequestId('large'),
  });
  console.log('large invoice:', large.status, 'hitl_id=', large.hitl_id);
  // -> "pending_review": a human reviewer must approve/reject/modify
  // (see 04-approve-reject-modify.ts) before the agent should execute it.
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
