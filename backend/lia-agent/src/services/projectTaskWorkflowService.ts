import type { LiaAgentConfig } from '../config.js';
import type { ProjectCodexCommitResult } from '../contracts/projectCodexCommit.js';
import type { ProjectCodexExecutionResult } from '../contracts/projectCodexExecution.js';
import type { ProjectCodexHandoff } from '../contracts/projectCodexHandoff.js';
import type { ProjectTaskRequest } from '../contracts/projectExecutor.js';
import type { ProjectRegistrySource } from '../contracts/projectRegistry.js';
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
import { planProjectTask } from './projectExecutionPlanner.js';
import {
  buildProjectOrchestrationPrompt,
  buildProjectOrchestrationRepairPrompt,
} from './projectOrchestrationPrompt.js';
import { validateProjectOrchestrationProposal } from './projectOrchestrationValidation.js';

type CodexExecutor = (handoff: ProjectCodexHandoff) => Promise<ProjectCodexExecutionResult>;
type VerificationExecutor = typeof verifyProjectCodexWorkspace;
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
): ProjectTaskWorkflowResult => ({ ok: false, status: 'failed', stage, error, summary, ...identifiers });

export async function executeProjectTaskWorkflow(
  config: LiaAgentConfig,
  request: ProjectTaskRequest,
  projectRegistrySource: ProjectRegistrySource,
  verificationRegistry?: ProjectVerificationRegistry,
  dependencies: ProjectTaskWorkflowDependencies = {},
): Promise<ProjectTaskWorkflowResult> {
  await observe(dependencies, 'planning');
  const planning = await planProjectTask(request, projectRegistrySource);
  if (!planning.ok) {
    return failed('planning', planning.error, 'Project task planning failed.');
  }

  const { plan } = planning;
  const identifiers = { projectId: plan.projectId };
  let prompt: string;
  try {
    prompt = buildProjectOrchestrationPrompt(plan);
  } catch (error) {
    return failed(
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
    return failed('hermes', hermesResult.error, 'Hermes reasoning did not complete.', identifiers);
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
      return failed('hermes', 'invalid_hermes_proposal', 'Hermes returned an invalid proposal.', identifiers);
    }
    initialError = 'invalid_hermes_proposal';
  }

  if (initialError !== undefined) {
    await observeHermesProposal(dependencies, initialError === 'invalid_hermes_json'
      ? 'initial_invalid_json'
      : 'initial_invalid_structure');
    let repairPrompt: string;
    try { repairPrompt = buildProjectOrchestrationRepairPrompt(plan); }
    catch { return failed('hermes', 'prompt_too_large', 'Hermes reasoning could not be prepared.', identifiers); }
    let repairedResult: HermesExecutionResult;
    try { repairedResult = await executeHermes(config, repairPrompt); }
    catch { repairedResult = { ok: false, error: 'execution_failed' }; }
    if (!repairedResult.ok) {
      return failed('hermes', repairedResult.error, 'Hermes reasoning did not complete.', identifiers);
    }
    try { parsed = JSON.parse(repairedResult.response); }
    catch {
      await observeHermesProposal(dependencies, 'repair_invalid_json');
      return failed('hermes', 'invalid_hermes_json', 'Hermes returned invalid JSON.', identifiers);
    }
    validation = validateProjectOrchestrationProposal(parsed, plan);
    if (!validation.success) {
      await observeHermesProposal(dependencies, 'repair_invalid_structure');
      return failed('hermes', 'invalid_hermes_proposal', 'Hermes returned an invalid proposal.', identifiers);
    }
    await observeHermesProposal(dependencies, 'repair_succeeded');
  }

  if (validation === undefined || !validation.success) {
    return failed('hermes', 'invalid_hermes_proposal', 'Hermes returned an invalid proposal.', identifiers);
  }
  if (validation.proposal.requiresHumanApproval || validation.proposal.blockedActions.length > 0) {
    return failed('approval', 'human_approval_required', 'Human approval is required.', identifiers);
  }

  const handoffResult = buildProjectCodexHandoff(plan, validation.proposal);
  if (!handoffResult.success) {
    return failed('hermes', 'invalid_hermes_proposal', 'Hermes returned an invalid proposal.', identifiers);
  }
  const effectiveCapabilities = handoffResult.handoff.effectiveCapabilities;
  if (effectiveCapabilities.includes('local_commit') && !effectiveCapabilities.includes('run_tests')) {
    return failed('hermes', 'invalid_hermes_proposal', 'Local commit requires successful verification.', identifiers);
  }

  let codexResult: ProjectCodexExecutionResult;
  await observe(dependencies, 'codex');
  try {
    codexResult = await (dependencies.executeCodex ?? executeProjectCodexHandoff)(handoffResult.handoff);
  } catch {
    return failed('codex', 'codex_execution_failed', 'Codex execution did not complete.', identifiers);
  }
  if (!codexResult.success) {
    return failed('codex', codexResult.error, codexResult.summary, {
      ...identifiers,
      executionId: codexResult.executionId,
    });
  }

  const executionIdentifiers = { ...identifiers, executionId: codexResult.executionId };
  if (!effectiveCapabilities.includes('isolated_worktree_write')) {
    return {
      ok: true,
      ...executionIdentifiers,
      status: 'analyzed',
      executionSummary: codexResult.summary,
      resultText: codexResult.resultText,
    };
  }
  if (!effectiveCapabilities.includes('run_tests')) {
    return {
      ok: true,
      ...executionIdentifiers,
      status: 'ready_for_review',
      executionSummary: codexResult.summary,
      resultText: codexResult.resultText,
    };
  }
  if (verificationRegistry === undefined) {
    return failed(
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
    return failed(
      'verification',
      'verification_unavailable',
      'Verification is not available for this project.',
      executionIdentifiers,
    );
  }
  if (!verificationResult.success) {
    return failed('verification', verificationResult.error, verificationResult.summary, executionIdentifiers);
  }
  if (verificationResult.executionId !== codexResult.executionId) {
    return failed(
      'verification',
      'invalid_generated_path',
      'The retained workspace could not be resolved safely.',
      executionIdentifiers,
    );
  }

  const verification = {
    status: 'verified' as const,
    checksPassed: verificationResult.checksPassed,
    totalChecks: verificationResult.totalChecks,
  };
  if (!effectiveCapabilities.includes('local_commit')) {
    return {
      ok: true,
      ...executionIdentifiers,
      status: 'verified',
      executionSummary: codexResult.summary,
      resultText: codexResult.resultText,
      verification,
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
    return failed('commit', 'git_commit_failed', 'The local commit could not be created.', executionIdentifiers);
  }
  if (!commitResult.success) {
    return failed('commit', commitResult.error, commitResult.summary, executionIdentifiers);
  }
  if (
    commitResult.executionId !== codexResult.executionId
    || !/^[0-9a-fA-F]{40,64}$/.test(commitResult.commit)
  ) {
    return failed(
      'commit',
      'git_revision_failed',
      'The local commit revision could not be validated.',
      executionIdentifiers,
    );
  }

  return {
    ok: true,
    ...executionIdentifiers,
    status: 'committed',
    executionSummary: codexResult.summary,
    resultText: buildCommittedResultText(verification, commitResult.commit),
    verification,
    commit: commitResult.commit,
  };
}
