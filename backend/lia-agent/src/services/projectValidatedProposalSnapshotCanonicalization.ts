import { createHash } from 'node:crypto';
import { PROJECT_TASK_VALIDATED_PROPOSAL_SNAPSHOT_CANONICAL_VERSION } from '../contracts/projectTaskValidatedProposalSnapshot.js';
import type { ProjectOrchestrationProposal } from '../contracts/projectOrchestration.js';

/**
 * Frozen 'validated-proposal-canonical-v1' serializer for the normalized
 * validated proposal object returned by validateProjectOrchestrationProposal.
 *
 * Rule (frozen at v1):
 * 1. Objects are serialized with keys sorted lexicographically (JavaScript
 *    string comparison == UTF-16 code-unit order); arrays preserve element
 *    order; strings are emitted as-is (already validator-normalized/trimmed);
 *    booleans and enums are JSON literals; NO whitespace anywhere.
 * 2. The validated proposal contains no numbers/undefined/null fields, so the
 *    output is deterministic across Node versions and platforms. Duplicate
 *    elimination and DAG checks were already performed by the validator.
 * 3. proposal_sha256 = sha256(canonical_json) as 64-char lowercase hex.
 * 4. Identical validated objects produce identical bytes; contradictory
 *    content on the same lineage produces a different hash and the store
 *    fails closed.
 *
 * Raw response bytes are NEVER canonicalized; the canonical JSON is the
 * durable representation.
 */
export function canonicalizeValidatedProposal(
  proposal: ProjectOrchestrationProposal,
): { canonicalJson: string; sha256: string } {
  const canonicalJson = canonicalSerialize(proposal);
  const sha256 = createHash('sha256').update(canonicalJson).digest('hex');
  return { canonicalJson, sha256 };
}

export function isCanonicalVersionV1(version: unknown): version is typeof PROJECT_TASK_VALIDATED_PROPOSAL_SNAPSHOT_CANONICAL_VERSION {
  return version === PROJECT_TASK_VALIDATED_PROPOSAL_SNAPSHOT_CANONICAL_VERSION;
}

function canonicalSerialize(value: unknown): string {
  if (Array.isArray(value)) {
    let result = '[';
    for (let index = 0; index < value.length; index += 1) {
      if (index > 0) result += ',';
      result += canonicalSerialize(value[index]);
    }
    return `${result}]`;
  }
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    let result = '{';
    for (let index = 0; index < keys.length; index += 1) {
      if (index > 0) result += ',';
      const key = keys[index];
      result += `${JSON.stringify(key)}:${canonicalSerialize(record[key])}`;
    }
    return `${result}}`;
  }
  return JSON.stringify(value);
}
