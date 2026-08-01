// Approve, reject, and structured modify — the three review resolutions.
// Fictional data only.
import { agentClient, ensurePolicy, newRequestId, reviewerClient } from './_shared.js';

async function main() {
  await ensurePolicy();
  const agent = agentClient();
  const reviewer = reviewerClient();

  // Approve: execute exactly as submitted.
  const toApprove = await agent.submitGovernedRequest({
    policyId: 'invoice-governance', tool: 'pay_invoice', action: 'submit',
    params: { amount: 5000 }, requestId: newRequestId('approve'),
  });
  const approved = await reviewer.approve(toApprove.hitl_id as string, { note: 'verified vendor' });
  console.log('approved:', approved.decision, approved.params);

  // Reject: nothing executes.
  const toReject = await agent.submitGovernedRequest({
    policyId: 'invoice-governance', tool: 'pay_invoice', action: 'submit',
    params: { amount: 6000 }, requestId: newRequestId('reject'),
  });
  const rejected = await reviewer.reject(toReject.hitl_id as string, { note: 'suspicious invoice' });
  console.log('rejected:', rejected.decision, rejected.params); // params is null

  // Modify: a structured replacement, re-evaluated before executing.
  const toModify = await agent.submitGovernedRequest({
    policyId: 'invoice-governance', tool: 'pay_invoice', action: 'submit',
    params: { amount: 5000 }, requestId: newRequestId('modify'),
  });
  const modified = await reviewer.modify(toModify.hitl_id as string,
    { amount: 900 }, { note: 'reduced to policy limit' });
  console.log('modified (within limit, executes):', modified.executed, modified.params);

  // Modify that still fails the hard policy: never executes, spawns a
  // follow-up review instead of an error.
  const toModifyAgain = await agent.submitGovernedRequest({
    policyId: 'invoice-governance', tool: 'pay_invoice', action: 'submit',
    params: { amount: 5000 }, requestId: newRequestId('modify-still-blocked'),
  });
  const stillBlocked = await reviewer.modify(toModifyAgain.hitl_id as string, { amount: 99999 });
  console.log('modified (still over limit, does not execute):',
    stillBlocked.executed, 'follow-up review:', stillBlocked.followUpReviewId);
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
