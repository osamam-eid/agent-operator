/**
 * Agent Operator — runtime-synthesized policy reference marker.
 *
 * Internal marker for runtime-synthesized policy statements (gate
 * descriptions, the no-mutation-occurred statement, degradation records).
 * Distinct from a node's own `AgentResult.policyRefs`, which this runtime
 * never fabricates.
 */
export const RUNTIME_POLICY_REF = 'operator-runtime@1';
