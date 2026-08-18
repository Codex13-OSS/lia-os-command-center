export type ProjectCodexCommitError =
  | "local_commit_not_approved"
  | "workspace_not_verified"
  | "invalid_generated_path"
  | "nothing_to_commit"
  | "git_status_failed"
  | "git_stage_failed"
  | "git_commit_failed"
  | "git_revision_failed";

/** Safe result: process and workspace internals must never be added here. */
export type ProjectCodexCommitResult =
  | {
      success: true;
      executionId: string;
      status: "committed";
      commit: string;
      summary: string;
    }
  | {
      success: false;
      executionId: string;
      status: "commit_failed";
      error: ProjectCodexCommitError;
      summary: string;
    };
