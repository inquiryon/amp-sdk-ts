// HITL polling: an agent submits a request that requires review, then
// waits for a human decision using the optional waitForDecision helper.
// In a real deployment, the "reviewer resolves" step below would happen
// from a separate process/person using the worktray UI or their own
// approve/reject/modify call — it is inlined here only so the example is
// runnable end-to-end without a second terminal. Fictional data only.
import { agentClient, ensurePolicy, newRequestId, reviewerClient } from './_shared.js';

async function main() {
  await ensurePolicy();
  const agent = agentClient();
  const reviewer = reviewerClient();

  const submitted = await agent.submitGovernedRequest({
    policyId: 'invoice-governance', tool: 'pay_invoice', action: 'submit',
    params: { amount: 5000 }, requestId: newRequestId('poll'),
  });
  console.log('submitted, awaiting review:', submitted.hitl_id);

  // Simulate a reviewer acting concurrently, after a short delay.
  setTimeout(() => {
    reviewer.approve(submitted.hitl_id as string)
      .then(() => console.log('(reviewer approved in the background)'))
      .catch((err) => console.error('reviewer approve failed', err));
  }, 500);

  const decision = await agent.waitForDecision(submitted.request_id, {
    intervalMs: 200, timeoutMs: 10_000,
  });
  console.log('final status:', decision.status, 'decision:', decision.decision,
    'executed_params:', decision.executed_params);
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
