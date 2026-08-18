export type ProjectCodexExecutionError =
  | "missing_repository_read"
  | "missing_isolated_worktree_write"
  | "prompt_too_large"
  | "invalid_generated_path"
  | "worktree_create_failed"
  | "codex_execution_failed"
  | "timeout"
  | "worktree_cleanup_failed";

/** Safe execution result. Repository and process internals must never be added here. */
export type ProjectCodexExecutionResult =
  | {
      success: true;
      executionId: string;
      status: "completed";
      summary: string;
      resultText: string;
      outcome: "analysis_completed" | "modification_completed";
    }
  | {
      success: false;
      executionId: string;
      status: "failed";
      error: ProjectCodexExecutionError;
      summary: string;
    };
