// Callback-delivery handling: after a review is resolved, the server
// records a durable delivery attempt (stable delivery_id, visible status,
// idempotent retry) instead of a fire-and-forget notification. Fictional
// data only.
import { agentClient, ensurePolicy, newRequestId, reviewerClient } from './_shared.js';

async function main() {
  await ensurePolicy();
  const agent = agentClient();
  const reviewer = reviewerClient();

  const submitted = await agent.submitGovernedRequest({
    policyId: 'invoice-governance', tool: 'pay_invoice', action: 'submit',
    params: { amount: 5000 }, requestId: newRequestId('callback'),
  });
  const outcome = await reviewer.approve(submitted.hitl_id as string);
  console.log('resolved with delivery_id:', outcome.deliveryId, 'delivered:', outcome.delivered);

  const status = await reviewer.getDeliveryStatus(outcome.deliveryId);
  console.log('delivery status:', status.status, 'attempts:', status.attempts);

  // Retrying an already-delivered id is safe (idempotent) — useful after a
  // transient failure without needing to re-decide the review.
  const retried = await reviewer.retryDelivery(outcome.deliveryId);
  console.log('retry result:', retried);
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
