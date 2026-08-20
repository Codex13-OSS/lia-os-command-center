import {
  PROJECT_GOAL_CONTINUATION_DEPTH_LIMIT,
  PROJECT_GOAL_MAX_ATTEMPTS_LIMIT,
} from './projectGoal.js';
import { AUTONOMY_POLICY_MAX_CYCLES_LIMIT } from './projectGoalAutonomyPolicy.js';

/** Stable, deterministic operational-complexity vocabulary. It is not a time promise. */
export const PROJECT_GOAL_COMPLEXITIES = ['low', 'medium', 'high', 'critical'] as const;
export type ProjectGoalComplexity = (typeof PROJECT_GOAL_COMPLEXITIES)[number];

/** Bounded execution-horizon ceiling, not an estimate of completion time. */
export const PROJECT_GOAL_MAX_ELAPSED_BUDGET_MS = 24 * 60 * 60 * 1000;
export const PROJECT_GOAL_MIN_ELAPSED_BUDGET_MS = 15 * 60 * 1000;

export type ProjectGoalEffortEstimateInput = {
  objective: string;
  priority?: 'low' | 'normal' | 'high' | 'critical';
};

export type ProjectGoalEffortEstimate = {
  complexity: ProjectGoalComplexity;
  recommendedMaxAttempts: number;
  recommendedContinuationDepth: number;
  recommendedMaxCycles: number;
  /** Bounded autonomy execution horizon. Never a promised duration. */
  recommendedElapsedBudgetMs: number;
  riskFactors: string[];
  rationale: string[];
  confidence: number;
};

/** Official clamps shared by the estimator and intake validation. */
export function clampGoalEffortLimits(input: {
  maxAttempts: number;
  continuationDepth: number;
  maxCycles: number;
  elapsedBudgetMs: number;
}): {
  maxAttempts: number;
  continuationDepth: number;
  maxCycles: number;
  elapsedBudgetMs: number;
} {
  const maxAttempts = Math.min(PROJECT_GOAL_MAX_ATTEMPTS_LIMIT, Math.max(1, Math.trunc(input.maxAttempts)));
  return {
    maxAttempts,
    continuationDepth: Math.min(PROJECT_GOAL_CONTINUATION_DEPTH_LIMIT, Math.max(0, Math.trunc(input.continuationDepth))),
    maxCycles: Math.min(AUTONOMY_POLICY_MAX_CYCLES_LIMIT, maxAttempts, Math.max(1, Math.trunc(input.maxCycles))),
    elapsedBudgetMs: Math.min(
      PROJECT_GOAL_MAX_ELAPSED_BUDGET_MS,
      Math.max(PROJECT_GOAL_MIN_ELAPSED_BUDGET_MS, Math.trunc(input.elapsedBudgetMs)),
    ),
  };
}
