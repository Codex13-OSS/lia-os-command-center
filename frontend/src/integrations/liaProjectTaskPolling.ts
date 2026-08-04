export const MAX_CONSECUTIVE_TEMPORARY_FAILURES = 8;

export function shouldPauseAfterTemporaryFailure(consecutiveFailures: number): boolean {
  return consecutiveFailures >= MAX_CONSECUTIVE_TEMPORARY_FAILURES;
}
