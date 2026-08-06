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

/** Independent copy of the backend-owned Autonomous V1 ceiling. */
export function createAutonomousV1ApprovedCapabilities(): AutonomousV1Capability[] {
  return [...AUTONOMOUS_V1_CEILING];
}
