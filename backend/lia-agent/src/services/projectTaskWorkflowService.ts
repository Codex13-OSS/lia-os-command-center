import type { LiaAgentConfig } from '../config.js';
import type { ProjectCodexCommitResult } from '../contracts/projectCodexCommit.js';
import type { ProjectCodexExecutionResult } from '../contracts/projectCodexExecution.js';
import type { ProjectCodexHandoff } from '../contracts/projectCodexHandoff.js';
import type { ProjectTaskRequest } from '../contracts/projectExecutor.js';
import type { ProjectRegistrySource } from '../contracts/projectRegistry.js';
import type { SafeTaskStage } from '../contracts/projectTask.js';
import type { ProjectTaskWorkflowResult } from '../contracts/projectTaskWorkflow.js';
import type { ProjectVerificationRegistry } from '../contracts/projectVerification.js';
import type { HermesExecutionResult, HermesQueryExecutor } from './hermesExecutor.js';
import { executeHermesSupervisor } from './hermesSupervisorExecutor.js';
import { commitVerifiedProjectCodexWorkspace } from './projectCodexCommit.js';
import { executeProjectCodexHandoff } from './projectCodexExecutor.js';
import { buildProjectCodexHandoff } from './projectCodexHandoff.js';
import {
  verifyProjectCodexWorkspace,
  type ProjectCodexVerificationResult,
} from './projectCodexVerification.js';
import {
  verifyProjectVisualWorkspace,
  type ProjectVisualVerificationResult,
} from './projectVisualVerification.js';
import { planProjectTask } from './projectExecutionPlanner.js';
import {
  buildProjectOrchestrationPrompt,
  buildProjectOrchestrationRepairPrompt,
} from './projectOrchestrationPrompt.js';
import { validateProjectOrchestrationProposal } from './projectOrchestrationValidation.js';

type CodexExecutor = (handoff: ProjectCodexHandoff) => Promise<ProjectCodexExecutionResult>;
type VerificationExecutor = typeof verifyProjectCodexWorkspace;
type VisualVerificationExecutor = typeof verifyProjectVisualWorkspace;
type CommitExecutor = typeof commitVerifiedProjectCodexWorkspace;

const MAX_RESULT_TEXT_CHARS = 6_000;

function buildCommittedResultText(
  verification: { checksPassed: number; totalChecks: number },
  commit: string,
): string {
  const finalResult = `Final verified result: ${verification.checksPassed}/${verification.totalChecks} checks passed and local commit ${commit} was created and validated.`;
  return finalResult.slice(0, MAX_RESULT_TEXT_CHARS);
}

export interface ProjectTaskWorkflowDependencies {
  executeHermes?: HermesQueryExecutor;
  executeCodex?: CodexExecutor;
  executeVerification?: VerificationExecutor;
  executeVisualVerification?: VisualVerificationExecutor;
  executeCommit?: CommitExecutor;
  /** Internal observability only. Receives no workflow internals. */
  onStage?: (stage: 'planning' | 'hermes' | 'codex' | 'verification' | 'commit') => void | Promise<void>;
  /** Internal, bounded diagnostics. Never includes prompts, responses, paths or process output. */
  onHermesProposalAttempt?: (outcome:
    | 'initial_invalid_json'
    | 'initial_invalid_structure'
    | 'repair_succeeded'
    | 'repair_invalid_json'
    | 'repair_invalid_structure'
  ) => void | Promise<void>;
}

const observe = async (dependencies: ProjectTaskWorkflowDependencies, stage: 'planning' | 'hermes' | 'codex' | 'verification' | 'commit') => {
  try { await dependencies.onStage?.(stage); } catch { /* State publication must not alter execution. */ }
};

const observeHermesProposal = async (
  dependencies: ProjectTaskWorkflowDependencies,
  outcome: Parameters<NonNullable<ProjectTaskWorkflowDependencies['onHermesProposalAttempt']>>[0],
) => {
  try { await dependencies.onHermesProposalAttempt?.(outcome); } catch { /* Diagnostics must not alter execution. */ }
};

function containsNonRetryableHermesAuthorityRequest(value: unknown, approvedCapabilities: readonly string[]): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proposal = value as Record<string, unknown>;
  if (proposal.requiresHumanApproval === true) return true;
  if (Array.isArray(proposal.blockedActions) && proposal.blockedActions.length > 0) return true;
  if (!Array.isArray(proposal.steps)) return false;
  return proposal.steps.some((step) => {
    if (typeof step !== 'object' || step === null || Array.isArray(step)) return false;
    const capabilities = (step as Record<string, unknown>).requiredCapabilities;
    return Array.isArray(capabilities) && capabilities.some(
      (capability) => typeof capability === 'string' && !approvedCapabilities.includes(capability),
    );
  });
}

const failed = (
  stage: Extract<ProjectTaskWorkflowResult, { ok: false }>['stage'],
  error: Extract<ProjectTaskWorkflowResult, { ok: false }>['error'],
  summary: string,
  identifiers: { projectId?: string; executionId?: string } = {},
  completedStages: readonly SafeTaskStage[] = [],
): ProjectTaskWorkflowResult => ({
  ok: false,
  status: 'failed',
  stage,
  error,
  summary,
  ...identifiers,
  ...(completedStages.length > 0 ? { completedStages: [...completedStages] } : {}),
});

export async function executeProjectTaskWorkflow(
  config: LiaAgentConfig,
  request: ProjectTaskRequest,
  projectRegistrySource: ProjectRegistrySource,
  verificationRegistry?: ProjectVerificationRegistry,
  dependencies: ProjectTaskWorkflowDependencies = {},
): Promise<ProjectTaskWorkflowResult> {
  const completedStages: SafeTaskStage[] = [];
  const markStage = (stage: SafeTaskStage): void => {
    completedStages[completedStages.length] = stage;
  };
  const fail = (
    stage: Extract<ProjectTaskWorkflowResult, { ok: false }>['stage'],
    error: Extract<ProjectTaskWorkflowResult, { ok: false }>['error'],
    summary: string,
    identifiers: { projectId?: string; executionId?: string } = {},
  ): ProjectTaskWorkflowResult => failed(stage, error, summary, identifiers, completedStages);

  await observe(dependencies, 'planning');
  const planning = await planProjectTask(request, projectRegistrySource);
  if (!planning.ok) {
    return fail('planning', planning.error, 'Project task planning failed.');
  }

  const { plan } = planning;
  markStage('planning');
  const identifiers = { projectId: plan.projectId };
  let prompt: string;
  try {
    prompt = buildProjectOrchestrationPrompt(plan);
  } catch (error) {
    return fail(
      'hermes',
      error instanceof Error && error.message === 'project_orchestration_prompt_too_large'
        ? 'prompt_too_large'
        : 'execution_failed',
      'Hermes reasoning could not be prepared.',
      identifiers,
    );
  }

  let hermesResult: HermesExecutionResult;
  await observe(dependencies, 'hermes');
  const executeHermes = dependencies.executeHermes ?? executeHermesSupervisor;
  const retryableHermesErrors = new Set(['timeout', 'execution_failed', 'empty_response']);
  for (let attempt = 0; ; attempt += 1) {
    try {
      hermesResult = await executeHermes(config, prompt);
    } catch {
      hermesResult = { ok: false, error: 'execution_failed' };
    }
    if (hermesResult.ok || attempt === 1 || !retryableHermesErrors.has(hermesResult.error)) break;
  }
  if (!hermesResult.ok) {
    return fail('hermes', hermesResult.error, 'Hermes reasoning did not complete.', identifiers);
  }

  let parsed: unknown;
  let initialError: 'invalid_hermes_json' | 'invalid_hermes_proposal' | undefined;
  try { parsed = JSON.parse(hermesResult.response); }
  catch { initialError = 'invalid_hermes_json'; }

  let validation = initialError === undefined
    ? validateProjectOrchestrationProposal(parsed, plan)
    : undefined;
  if (validation !== undefined && !validation.success) {
    if (containsNonRetryableHermesAuthorityRequest(parsed, plan.approvedCapabilities)) {
      return fail('hermes', 'invalid_hermes_proposal', 'Hermes returned an invalid proposal.', identifiers);
    }
    initialError = 'invalid_hermes_proposal';
  }

  if (initialError !== undefined) {
    await observeHermesProposal(dependencies, initialError === 'invalid_hermes_json'
      ? 'initial_invalid_json'
      : 'initial_invalid_structure');
    const repairValidationErrors = initialError === 'invalid_hermes_json'
      ? [{ path: '$', message: 'response must be valid JSON' }]
      : validation !== undefined && !validation.success
        ? validation.errors
        : [];

    let repairPrompt: string;
    try { repairPrompt = buildProjectOrchestrationRepairPrompt(plan, repairValidationErrors); }
    catch { return fail('hermes', 'prompt_too_large', 'Hermes reasoning could not be prepared.', identifiers); }
    let repairedResult: HermesExecutionResult;
    try { repairedResult = await executeHermes(config, repairPrompt); }
    catch { repairedResult = { ok: false, error: 'execution_failed' }; }
    if (!repairedResult.ok) {
      return fail('hermes', repairedResult.error, 'Hermes reasoning did not complete.', identifiers);
    }
    try { parsed = JSON.parse(repairedResult.response); }
    catch {
      await observeHermesProposal(dependencies, 'repair_invalid_json');
      return fail('hermes', 'invalid_hermes_json', 'Hermes returned invalid JSON.', identifiers);
    }
    validation = validateProjectOrchestrationProposal(parsed, plan);
    if (!validation.success) {
      await observeHermesProposal(dependencies, 'repair_invalid_structure');
      return fail('hermes', 'invalid_hermes_proposal', 'Hermes returned an invalid proposal.', identifiers);
    }
    await observeHermesProposal(dependencies, 'repair_succeeded');
  }

  if (validation === undefined || !validation.success) {
    return fail('hermes', 'invalid_hermes_proposal', 'Hermes returned an invalid proposal.', identifiers);
  }
  if (validation.proposal.requiresHumanApproval || validation.proposal.blockedActions.length > 0) {
    return fail('approval', 'human_approval_required', 'Human approval is required.', identifiers);
  }

  const handoffResult = buildProjectCodexHandoff(plan, validation.proposal);
  if (!handoffResult.success) {
    return fail('hermes', 'invalid_hermes_proposal', 'Hermes returned an invalid proposal.', identifiers);
  }
  const effectiveCapabilities = handoffResult.handoff.effectiveCapabilities;
  if (effectiveCapabilities.includes('local_commit') && !effectiveCapabilities.includes('run_tests')) {
    return fail('hermes', 'invalid_hermes_proposal', 'Local commit requires successful verification.', identifiers);
  }
  markStage('hermes');

  let codexResult: ProjectCodexExecutionResult;
  await observe(dependencies, 'codex');
  try {
    codexResult = await (dependencies.executeCodex ?? executeProjectCodexHandoff)(handoffResult.handoff);
  } catch {
    return fail('codex', 'codex_execution_failed', 'Codex execution did not complete.', identifiers);
  }
  if (!codexResult.success) {
    return fail('codex', codexResult.error, codexResult.summary, {
      ...identifiers,
      executionId: codexResult.executionId,
    });
  }
  markStage('codex');

  const executionIdentifiers = { ...identifiers, executionId: codexResult.executionId };
  if (!effectiveCapabilities.includes('isolated_worktree_write')) {
    return {
      ok: true,
      ...executionIdentifiers,
      status: 'analyzed',
      executionSummary: codexResult.summary,
      resultText: codexResult.resultText,
      stages: [...completedStages],
    };
  }
  if (!effectiveCapabilities.includes('run_tests')) {
    return {
      ok: true,
      ...executionIdentifiers,
      status: 'ready_for_review',
      executionSummary: codexResult.summary,
      resultText: codexResult.resultText,
      stages: [...completedStages],
    };
  }
  if (verificationRegistry === undefined) {
    return fail(
      'verification',
      'verification_unavailable',
      'Verification is not available for this project.',
      executionIdentifiers,
    );
  }

  let verificationResult: ProjectCodexVerificationResult;
  await observe(dependencies, 'verification');
  try {
    verificationResult = await (dependencies.executeVerification ?? verifyProjectCodexWorkspace)(
      plan.repositoryRoot,
      plan.projectId,
      codexResult.executionId,
      verificationRegistry,
    );
  } catch {
    return fail(
      'verification',
      'verification_unavailable',
      'Verification is not available for this project.',
      executionIdentifiers,
    );
  }
  if (!verificationResult.success) {
    return fail('verification', verificationResult.error, verificationResult.summary, executionIdentifiers);
  }
  if (verificationResult.executionId !== codexResult.executionId) {
    return fail(
      'verification',
      'invalid_generated_path',
      'The retained workspace could not be resolved safely.',
      executionIdentifiers,
    );
  }
  markStage('verification');

  let visualVerificationResult: ProjectVisualVerificationResult;
  try {
    visualVerificationResult = await (
      dependencies.executeVisualVerification ?? verifyProjectVisualWorkspace
    )(
      plan.projectId,
      codexResult.executionId,
    );
  } catch {
    return fail(
      'verification',
      'verification_unavailable',
      'Visual verification is not available for this project.',
      executionIdentifiers,
    );
  }

  if (!visualVerificationResult.success) {
    return fail(
      'verification',
      visualVerificationResult.error === 'visual_check_failed'
        ? 'visual_check_failed'
        : visualVerificationResult.error === 'visual_check_timeout'
          ? 'visual_check_timeout'
          : 'visual_verification_unavailable',
      visualVerificationResult.summary,
      executionIdentifiers,
    );
  }

  if (visualVerificationResult.executionId !== codexResult.executionId) {
    return fail(
      'verification',
      'invalid_generated_path',
      'The retained workspace could not be resolved safely.',
      executionIdentifiers,
    );
  }
  markStage('visualQa');

  const verification = {
    status: 'verified' as const,
    checksPassed:
      verificationResult.checksPassed
      + visualVerificationResult.checksPassed,
    totalChecks:
      verificationResult.totalChecks
      + visualVerificationResult.totalChecks,
  };
  if (!effectiveCapabilities.includes('local_commit')) {
    return {
      ok: true,
      ...executionIdentifiers,
      status: 'verified',
      executionSummary: codexResult.summary,
      resultText: codexResult.resultText,
      verification,
      stages: [...completedStages],
    };
  }

  let commitResult: ProjectCodexCommitResult;
  await observe(dependencies, 'commit');
  try {
    commitResult = await (dependencies.executeCommit ?? commitVerifiedProjectCodexWorkspace)(
      plan.repositoryRoot,
      codexResult.executionId,
      effectiveCapabilities,
      verificationResult,
    );
  } catch {
    return fail('commit', 'git_commit_failed', 'The local commit could not be created.', executionIdentifiers);
  }
  if (!commitResult.success) {
    return fail('commit', commitResult.error, commitResult.summary, executionIdentifiers);
  }
  if (
    commitResult.executionId !== codexResult.executionId
    || !/^[0-9a-fA-F]{40,64}$/.test(commitResult.commit)
  ) {
    return fail(
      'commit',
      'git_revision_failed',
      'The local commit revision could not be validated.',
      executionIdentifiers,
    );
  }
  markStage('commit');

  return {
    ok: true,
    ...executionIdentifiers,
    status: 'committed',
    executionSummary: codexResult.summary,
    resultText: buildCommittedResultText(verification, commitResult.commit),
    verification,
    commit: commitResult.commit,
    stages: [...completedStages],
  };
}
