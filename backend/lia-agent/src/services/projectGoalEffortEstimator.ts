import type {
  ProjectGoalEffortEstimate,
  ProjectGoalEffortEstimateInput,
} from '../contracts/projectGoalEffortEstimate.js';
import { clampGoalEffortLimits } from '../contracts/projectGoalEffortEstimate.js';

/**
 * Deterministic, read-only operational-complexity estimator.
 *
 * It uses only explicit intake facts: normalized objective text and priority.
 * It does not call a model, inspect authority/capabilities, promise completion
 * time, persist state, or change the Goal. Unrecognized/ambiguous signals are
 * intentionally ignored rather than guessed.
 */
export function estimateProjectGoalEffort(
  input: ProjectGoalEffortEstimateInput,
): ProjectGoalEffortEstimate {
  const objective = input.objective.trim();
  const normalized = objective.toLocaleLowerCase('en-US');
  const priority = input.priority ?? 'normal';
  let score = 0;
  const riskFactors: string[] = [];
  const rationale: string[] = [];

  if (objective.length >= 1_200) {
    score += 2;
    riskFactors.push('broad_intake');
    rationale.push('The intake is broad (at least 1,200 characters).');
  } else if (objective.length >= 400) {
    score += 1;
    rationale.push('The intake contains substantial detail (at least 400 characters).');
  } else {
    rationale.push('The intake is compact (under 400 characters).');
  }

  const explicitIntegration = /\b(integrat(?:e|ion)|migrat(?:e|ion)|multi[- ]?service|cross[- ]?system|end[- ]to[- ]end)\b/u.test(normalized);
  if (explicitIntegration) {
    score += 2;
    riskFactors.push('explicit_cross_component_work');
    rationale.push('The objective explicitly names integration, migration, or cross-component work.');
  }

  const explicitSafetyBoundary = /\b(security|authentication|authorization|permission|credential|production|database migration|compliance)\b/u.test(normalized);
  if (explicitSafetyBoundary) {
    score += 2;
    riskFactors.push('explicit_safety_boundary');
    rationale.push('The objective explicitly names a safety-sensitive boundary.');
  }

  const enumeratedSteps = objective.match(/(?:^|\n)\s*(?:[-*]|\d+[.)])\s+/g)?.length ?? 0;
  if (enumeratedSteps >= 5) {
    score += 2;
    riskFactors.push('many_explicit_steps');
    rationale.push('The intake explicitly enumerates at least five work items.');
  } else if (enumeratedSteps >= 2) {
    score += 1;
    rationale.push('The intake explicitly enumerates multiple work items.');
  }

  if (priority === 'critical') {
    score += 3;
    riskFactors.push('critical_priority');
    rationale.push('The operator marked the Goal as critical priority.');
  } else if (priority === 'high') {
    score += 1;
    rationale.push('The operator marked the Goal as high priority.');
  }

  const complexity = score >= 7 ? 'critical' : score >= 4 ? 'high' : score >= 2 ? 'medium' : 'low';
  const rawLimits = complexity === 'critical'
    ? { maxAttempts: 5, continuationDepth: 4, maxCycles: 5, elapsedBudgetMs: 12 * 60 * 60 * 1000 }
    : complexity === 'high'
      ? { maxAttempts: 4, continuationDepth: 3, maxCycles: 4, elapsedBudgetMs: 6 * 60 * 60 * 1000 }
      : complexity === 'medium'
        ? { maxAttempts: 3, continuationDepth: 2, maxCycles: 3, elapsedBudgetMs: 2 * 60 * 60 * 1000 }
        : { maxAttempts: 2, continuationDepth: 1, maxCycles: 2, elapsedBudgetMs: 30 * 60 * 1000 };
  const limits = clampGoalEffortLimits(rawLimits);

  return {
    complexity,
    recommendedMaxAttempts: limits.maxAttempts,
    recommendedContinuationDepth: limits.continuationDepth,
    recommendedMaxCycles: limits.maxCycles,
    recommendedElapsedBudgetMs: limits.elapsedBudgetMs,
    riskFactors,
    rationale,
    // Confidence is about classification from explicit signals, not success.
    confidence: riskFactors.length > 0 || enumeratedSteps >= 2 || objective.length >= 400 ? 0.9 : 0.75,
  };
}
