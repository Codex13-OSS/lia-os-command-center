import type { ProjectGoalRecord } from '../contracts/projectGoal.js';
import type { ProjectTaskRecord } from '../contracts/projectTask.js';
import type { ProjectGoalEvaluationEvidence } from '../contracts/projectGoalEvaluation.js';
import { isProjectGoalEvaluationEvidence } from './projectCompletionEvaluator.js';
import type { LiaAgentConfig } from '../config.js';
import { executeHermesReasoningOnly } from './hermesReasoningExecutor.js';

/**
 * Q3 Layer B — Goal Satisfaction Assessor.
 *
 * Produces the bounded, advisory `ProjectGoalEvaluationEvidence`
 * ({ goalSatisfaction, blocking, failure }) that the existing deterministic
 * evaluator (`evaluateProjectGoalCompletion`) gates into a final
 * `decision`/`reasonCode`. It holds ZERO execution authority:
 *
 *  - the output carries no prose, paths, commands, capabilities, credentials
 *    or executable fields;
 *  - the output is strictly validated by `isProjectGoalEvaluationEvidence`;
 *  - anything invalid (or any assessor failure) is treated as indeterminate by
 *    the orchestrator and can only be made MORE conservative by Layer A.
 *
 * Two substrates are provided, per the ratified material questions:
 *  - `createMechanicalGoalAssessor` — deterministic, mechanical classification
 *    (preferred for qualification fixtures, MQ1);
 *  - `createHermesReasoningGoalAssessor` — reasoning-only Hermes as a bounded
 *    advisory classifier for general goals (MQ1), with no toolsets and no
 *    execution authority. Its output is validated and falls back to a
 *    conservative classification on any failure.
 */

export const MAX_RESULT_EXCERPT_CHARS = 4_000;

/** Layer B input contract. `resultExcerpt` is the MQ2 bounded, sanitized, read-only excerpt. */
export type ProjectGoalSemanticAssessmentInput = {
  goal: ProjectGoalRecord;
  task: ProjectTaskRecord;
  /**
   * Bounded, sanitized, READ-ONLY excerpt of the actual committed result
   * (diff/file content), supplied by a caller holding `repository_read`
   * authority (MQ2). It is never persisted: it exists only for the duration of
   * the assessment and never enters the durable evaluation record.
   */
  resultExcerpt?: string;
};

export type ProjectGoalSemanticAssessor = (
  input: ProjectGoalSemanticAssessmentInput,
) => ProjectGoalEvaluationEvidence | Promise<ProjectGoalEvaluationEvidence>;

/**
 * The deterministic classification seam. For qualification fixtures this is a
 * mechanical predicate grounded in the actual result; for general goals it may
 * be a reasoning-only Hermes call. The output is the exact 3-field bounded
 * evidence vocabulary — nothing else.
 */
export type ProjectGoalSemanticClassifier = (
  goal: ProjectGoalRecord,
  task: ProjectTaskRecord,
  resultText: string,
  excerpt: string | undefined,
) => ProjectGoalEvaluationEvidence;

export type ProjectGoalReasoningOutcome =
  | { ok: true; response: string }
  | { ok: false; error: string };

export type ProjectGoalReasoningExecutor = (
  query: string,
) => Promise<ProjectGoalReasoningOutcome>;

const normalize = (value: string): string => value.replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Conservative deterministic match: only `satisfied` when the normalized
 * objective is fully contained in the normalized visible result. It never
 * asserts satisfaction from a pipeline summary alone, so a technically
 * completed task whose visible result does not materially contain the
 * objective is classified `not_demonstrated` (and Layer A downgrades it).
 */
export function conservativeObjectiveMatch(
  objective: string,
  resultText: string,
  excerpt: string | undefined,
): ProjectGoalEvaluationEvidence['goalSatisfaction'] {
  const objectiveNorm = normalize(objective);
  if (objectiveNorm.length === 0) return 'not_demonstrated';
  const candidate = excerpt !== undefined && normalize(excerpt).length > 0
    ? normalize(excerpt)
    : normalize(resultText);
  if (candidate.includes(objectiveNorm)) return 'satisfied';
  return 'not_demonstrated';
}

/**
 * Default mechanical classifier. It is deliberately conservative and never
 * upgrades: failed tasks are `not_demonstrated` with `retryable` recoverability
 * (unless the failure requires human approval), and completed tasks use the
 * bounded objective-vs-result containment match.
 */
export function conservativeSemanticClassifier(
  goal: ProjectGoalRecord,
  task: ProjectTaskRecord,
  resultText: string,
  excerpt: string | undefined,
): ProjectGoalEvaluationEvidence {
  if (task.status === 'failed') {
    return {
      goalSatisfaction: 'not_demonstrated',
      blocking: task.error?.code === 'human_approval_required' ? 'human_approval_required' : 'none',
      failure: 'retryable',
    };
  }
  return {
    goalSatisfaction: conservativeObjectiveMatch(goal.objective, resultText, excerpt),
    blocking: 'none',
    failure: 'retryable',
  };
}

/**
 * Mechanical (deterministic) Layer B assessor. The classification seam is
 * injectable so qualification fixtures can supply an exact deterministic
 * predicate; the default is the conservative mechanical match.
 */
export function createMechanicalGoalAssessor(
  classify: ProjectGoalSemanticClassifier = conservativeSemanticClassifier,
): ProjectGoalSemanticAssessor {
  return (input: ProjectGoalSemanticAssessmentInput): ProjectGoalEvaluationEvidence => {
    const resultText = typeof input.task.receipt?.resultText === 'string'
      ? input.task.receipt.resultText
      : '';
    const excerpt = input.resultExcerpt;
    return classify(input.goal, input.task, resultText, excerpt);
  };
}

const HERMES_ASSESSOR_PROMPT = String.raw`You are a bounded semantic classifier. Read the immutable objective and the bounded visible result below. Return ONLY a single-line JSON object with exactly three keys and no other text:

{"goalSatisfaction":"satisfied|partial|not_demonstrated","blocking":"none|human_approval_required|forbidden_capability_required|external_dependency","failure":"retryable|unrecoverable"}

Rules:
- "satisfied" only when the visible result materially satisfies the objective with no residual unsatisfied work.
- "partial" when some of the objective was delivered but some remains.
- "not_demonstrated" when the visible result does not match the objective or no safe match can be established.
- blocking reports only a residual gap that requires human approval, a forbidden capability, or an external prerequisite.
- You have no authority, no tools, no commands, no paths, no capabilities. Output the JSON object only.`;

/**
 * Reasoning-only Hermes Layer B assessor (MQ1). The model has NO toolsets and
 * NO execution authority. Its raw output is bounded, parsed and validated
 * against `isProjectGoalEvaluationEvidence`; any failure (timeout, empty,
 * invalid JSON, out-of-vocabulary fields, extra fields) falls back to the
 * conservative classifier. The raw response is discarded and never persisted.
 */
export function createHermesReasoningGoalAssessor(
  executeReasoning: ProjectGoalReasoningExecutor,
  options: {
    fallback?: ProjectGoalSemanticClassifier;
    maxObjectiveChars?: number;
    maxResultChars?: number;
  } = {},
): ProjectGoalSemanticAssessor {
  const fallback = options.fallback ?? conservativeSemanticClassifier;
  const maxObjectiveChars = options.maxObjectiveChars ?? 4_000;
  const maxResultChars = options.maxResultChars ?? MAX_RESULT_EXCERPT_CHARS;

  return async (input: ProjectGoalSemanticAssessmentInput): Promise<ProjectGoalEvaluationEvidence> => {
    const resultText = typeof input.task.receipt?.resultText === 'string'
      ? input.task.receipt.resultText
      : '';
    const excerpt = input.resultExcerpt;

    const objective = input.goal.objective.slice(0, maxObjectiveChars);
    const visibleResult = (excerpt !== undefined && excerpt.trim() !== ''
      ? excerpt
      : resultText).slice(0, maxResultChars);

    const query = [
      HERMES_ASSESSOR_PROMPT,
      `Objective: ${objective}`,
      `Visible result: ${visibleResult}`,
    ].join('\n\n');

    let outcome: ProjectGoalReasoningOutcome;
    try {
      outcome = await executeReasoning(query);
    } catch {
      outcome = { ok: false, error: 'execution_failed' };
    }

    if (!outcome.ok) {
      return fallback(input.goal, input.task, resultText, excerpt);
    }

    try {
      const parsed: unknown = JSON.parse(outcome.response);
      if (!isProjectGoalEvaluationEvidence(parsed)) {
        return fallback(input.goal, input.task, resultText, excerpt);
      }
      return parsed;
    } catch {
      return fallback(input.goal, input.task, resultText, excerpt);
    }
  };
}

/**
 * Bounds and sanitizes a raw result excerpt (MQ2). Strips control characters,
 * redacts private-key material, and truncates to the hard bound. It never
 * grants authority and its output is never persisted.
 */
export function sanitizeResultExcerpt(
  raw: string,
  maxChars: number = MAX_RESULT_EXCERPT_CHARS,
): string {
  return raw
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gi,
      '[REDACTED_PRIVATE_KEY]',
    )
    .slice(0, maxChars);
}

/**
 * Binds the Hermes Layer B assessor to the EXISTING reasoning-only Hermes
 * executor (`executeHermesReasoningOnly`, no toolsets). Reuses the LÍA
 * primitive exactly as the design requires (MQ1). The executor's output is
 * still validated and downgraded; it grants no execution authority.
 */
export function createHermesReasoningOnlyGoalAssessor(
  config: LiaAgentConfig,
  options: {
    fallback?: ProjectGoalSemanticClassifier;
    maxObjectiveChars?: number;
    maxResultChars?: number;
  } = {},
): ProjectGoalSemanticAssessor {
  return createHermesReasoningGoalAssessor(
    async (query: string): Promise<ProjectGoalReasoningOutcome> => {
      const result = await executeHermesReasoningOnly(config, query);
      return result.ok
        ? { ok: true, response: result.response }
        : { ok: false, error: result.error };
    },
    options,
  );
}
