import { parentPort, workerData } from 'node:worker_threads';
import { ProjectTaskSqliteStore } from '../../dist/services/projectTaskSqliteStore.js';

const store = new ProjectTaskSqliteStore({
  databasePath: workerData.databasePath,
  now: () => workerData.now,
});
try {
  let result;
  if (workerData.action === 'enqueue') {
    result = store.enqueueTaskDispatch(workerData.taskId);
  } else if (workerData.action === 'claim') {
    result = store.claimTaskDispatch(workerData.input);
  } else if (workerData.action === 'consume') {
    result = store.consumeTaskDispatch(workerData.input);
  } else if (workerData.action === 'prepare') {
    result = store.prepareTaskExecutionRun(workerData.input);
  } else {
    throw new Error('invalid_worker_action');
  }
  parentPort.postMessage({ ok: true, result });
} catch (error) {
  parentPort.postMessage({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  });
} finally {
  store.close();
}
