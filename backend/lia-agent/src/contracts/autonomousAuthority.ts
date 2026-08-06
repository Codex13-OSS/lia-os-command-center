/**
 * Backend-owned Autonomous V1 capability ceiling.
 *
 * The LÍA backend is the SOLE authority for the safe autonomous execution
 * ceiling. These four capabilities are the only ones that may ever be
 * autonomously authorized. Client-provided request metadata
 * (requestedCapabilities) is metadata ONLY: it never grants, reduces,
 * redefines, or otherwise controls this ceiling.
 */
export const AUTONOMOUS_V1_CEILING = [
  'repository_read',
  'isolated_worktree_write',
  'run_tests',
  'local_commit',
] as const;

export type AutonomousV1Capability = (typeof AUTONOMOUS_V1_CEILING)[number];

/**
 * Actions that must NEVER become autonomous authority. They remain forbidden
 * or human-gated only.
 */
export const AUTONOMOUS_V1_FORBIDDEN_CAPABILITIES = [
  'push',
  'merge',
  'deploy',
  'production_write',
  'database_write',
  'secret_access',
] as const;

export type AutonomousV1ForbiddenCapability =
  (typeof AUTONOMOUS_V1_FORBIDDEN_CAPABILITIES)[number];

/**
 * Completion intent values understood by LÍA Autonomous Completion V1.
 *
 * A completionMode value is VALIDATED INTENT METADATA ONLY. It is never
 * authority by itself: the LÍA backend policy is the sole authority that
 * translates a validated completion intent into binding workflow behavior.
 *
 * - "analyze": genuine read-only inspection / explanation / architecture
 *   review. It must never bind write, run_tests or local_commit.
 * - "ready_for_review": explicit draft / experiment / preview / provisional
 *   change. It preserves the legacy non-final write-only behavior.
 * - "complete": normal implementation / fix / create / update / finish where
 *   the user expects a finished result. For a write-capable modification the
 *   backend binds the full safe completion prerequisites.
 */
export const AUTONOMOUS_V1_COMPLETION_MODES = [
  'analyze',
  'ready_for_review',
  'complete',
] as const;

export type AutonomousV1CompletionMode =
  (typeof AUTONOMOUS_V1_COMPLETION_MODES)[number];

/**
 * Backend-owned safe completion prerequisites. When a validated
 * completionMode="complete" proposal includes a modification requiring
 * isolated_worktree_write, LÍA binds EXACTLY this set (capped by the
 * Autonomous V1 ceiling) so that verification always executes and a local
 * commit may occur only after verification succeeds.
 */
export const AUTONOMOUS_V1_COMPLETE_PRECONDITIONS = [
  'repository_read',
  'isolated_worktree_write',
  'run_tests',
  'local_commit',
] as const;

export type AutonomousV1CompletePrecondition =
  (typeof AUTONOMOUS_V1_COMPLETE_PRECONDITIONS)[number];

export type AutonomousV1CompletionBindingResult =
  | { ok: true; capabilities: AutonomousV1Capability[] }
  | {
    ok: false;
    reason:
      | 'unknown_completion_mode'
      | 'analyze_not_read_only'
      | 'local_commit_without_run_tests'
      | 'completion_preconditions_unavailable';
  };

/**
 * Backend-owned policy that derives the BINDING execution capability set from
 * a validated completion intent.
 *
 * Hermes requiredCapabilities remain the minimum operational requirements of
 * its own steps; they are never trusted to remember run_tests/local_commit.
 * The binding set for completionMode="complete" modification work is derived
 * here, from BACKEND POLICY, never from client authority and never from
 * Hermes authority expansion.
 *
 * Rules enforced here (fail closed):
 * - analyze binds only read-only capabilities.
 * - ready_for_review binds exactly the validated proposed capabilities.
 * - complete with isolated_worktree_write binds the union of the proposed
 *   capabilities and the safe completion prerequisites, capped by
 *   approvedCapabilities; a write operation is never manufactured for a
 *   read-only proposal.
 * - local_commit never binds without run_tests.
 * - the resulting set never leaves approvedCapabilities (and therefore never
 *   leaves the Autonomous V1 ceiling).
 */
export function deriveAutonomousV1CompletionCapabilities(
  completionMode: AutonomousV1CompletionMode,
  proposedCapabilities: readonly AutonomousV1Capability[],
  approvedCapabilities: readonly AutonomousV1Capability[],
): AutonomousV1CompletionBindingResult {
  if (completionMode === 'analyze') {
    const nonReadOnly = proposedCapabilities.find(
      (capability) => capability !== 'repository_read',
    );
    if (nonReadOnly !== undefined) {
      return { ok: false, reason: 'analyze_not_read_only' };
    }
    return { ok: true, capabilities: [...proposedCapabilities] };
  }

  if (completionMode === 'ready_for_review') {
    return { ok: true, capabilities: [...proposedCapabilities] };
  }

  if (completionMode === 'complete') {
    let binding: AutonomousV1Capability[] = [...proposedCapabilities];
    if (proposedCapabilities.includes('isolated_worktree_write')) {
      binding = [...new Set([
        ...binding,
        ...AUTONOMOUS_V1_COMPLETE_PRECONDITIONS,
      ])];
    }
    if (binding.includes('local_commit') && !binding.includes('run_tests')) {
      return { ok: false, reason: 'local_commit_without_run_tests' };
    }
    if (binding.some((capability) => !approvedCapabilities.includes(capability))) {
      return { ok: false, reason: 'completion_preconditions_unavailable' };
    }
    return { ok: true, capabilities: binding };
  }

  return { ok: false, reason: 'unknown_completion_mode' };
}

/** Independent copy of the backend-owned Autonomous V1 ceiling. */
export function createAutonomousV1ApprovedCapabilities(): AutonomousV1Capability[] {
  return [...AUTONOMOUS_V1_CEILING];
}
