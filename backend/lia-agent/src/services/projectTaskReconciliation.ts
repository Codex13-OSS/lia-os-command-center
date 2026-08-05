import type { ProjectTaskReconciler, ProjectTaskStore } from '../contracts/projectTask.js';

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
