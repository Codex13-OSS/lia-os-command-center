import type {
  ProjectTaskReconciler,
  ProjectTaskRestartRecoveryResult,
  ProjectTaskRestartSafeReconciler,
  ProjectTaskStore,
} from '../contracts/projectTask.js';

/**
 * Typed capability guard: detects durable stores that expose the explicit
 * reconcileInterruptedTasks operation without relying on instanceof.
 */
export function hasReconcileInterruptedTasks(
  store: ProjectTaskStore,
): store is ProjectTaskStore & ProjectTaskReconciler {
  return typeof (store as ProjectTaskStore & Partial<ProjectTaskReconciler>).reconcileInterruptedTasks === 'function';
}

/**
 * Reconciles interrupted tasks when the store supports it and returns the
 * number of reconciled tasks. Stores without the durable capability are left
 * untouched and report zero. A reconcile failure propagates: the caller must
 * fail startup closed instead of falling back silently to memory.
 */
export function reconcileInterruptedTasksIfSupported(store: ProjectTaskStore): number {
  if (!hasReconcileInterruptedTasks(store)) {
    return 0;
  }

  return store.reconcileInterruptedTasks();
}

/** Detects the conservative durable restart-recovery capability. */
export function hasReconcileRestartSafeTasks(
  store: ProjectTaskStore,
): store is ProjectTaskStore & ProjectTaskRestartSafeReconciler {
  return typeof (store as ProjectTaskStore & Partial<ProjectTaskRestartSafeReconciler>)
    .reconcileRestartSafeTasks === 'function';
}

/**
 * Performs startup reconciliation. Durable stores with restart-safe evidence
 * use the new conservative matrix. Older durable stores retain their legacy
 * fail-closed behavior; ephemeral stores have no state to recover.
 */
export function reconcileProjectTasksAtStartup(
  store: ProjectTaskStore,
): ProjectTaskRestartRecoveryResult {
  if (hasReconcileRestartSafeTasks(store)) {
    return store.reconcileRestartSafeTasks();
  }
  if (hasReconcileInterruptedTasks(store)) {
    return {
      preservedRecoverable: 0,
      failedInterrupted: store.reconcileInterruptedTasks(),
      terminalUnchanged: 0,
      resumableAvailable: 0,
    };
  }
  return { preservedRecoverable: 0, failedInterrupted: 0, terminalUnchanged: 0, resumableAvailable: 0 };
}
