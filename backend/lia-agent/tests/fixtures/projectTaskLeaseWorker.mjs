import { parentPort, workerData } from 'node:worker_threads';
import { ProjectTaskSqliteStore } from '../../dist/services/projectTaskSqliteStore.js';

const store = new ProjectTaskSqliteStore({
  databasePath: workerData.databasePath,
  now: () => workerData.now,
});
try {
  const lease = workerData.action === 'renew'
    ? store.renewTaskLease({ ...workerData.authority, durationMs: workerData.durationMs })
    : workerData.action === 'release'
      ? store.releaseTaskLease(workerData.authority)
      : store.acquireTaskLease({
        taskId: workerData.taskId,
        leaseOwner: workerData.leaseOwner,
        durationMs: workerData.durationMs,
      });
  parentPort.postMessage({ ok: true, lease });
} catch (error) {
  parentPort.postMessage({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  });
} finally {
  store.close();
}
