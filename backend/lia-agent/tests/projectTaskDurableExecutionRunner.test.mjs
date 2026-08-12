import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApp } from '../dist/app.js';
import { loadConfig } from '../dist/config.js';
import { SAFE_TASK_ERROR_MESSAGES } from '../dist/contracts/projectTask.js';
import { PROJECT_TASK_SQLITE_SCHEMA_VERSION } from '../dist/services/projectTaskSqliteSchema.js';
import { ProjectTaskSqliteStore } from '../dist/services/projectTaskSqliteStore.js';
import { InMemoryProjectTaskStore } from '../dist/services/inMemoryProjectTaskStore.js';
import {
  createProjectTaskDurableExecutionRunner,
  hasProjectTaskDurableExecutionPrimitives,
  runProjectTaskDurableExecution,
} from '../dist/services/projectTaskDurableExecutionRunner.js';

const TASK_A = '450e8400-e29b-41d4-a716-446655440000';
const TASK_B = '450e8400-e29b-41d4-a716-446655440001';
const intent = {
  projectId: 'approved-project',
  instruction: 'Inspect the repository read-only and report the architecture.',
  priority: 'normal',
  requestedCapabilities: ['repository_read'],
};
const registry = {
  read: async () => [{
    projectId: 'approved-project',
    displayName: 'Approved Project',
    repositoryRoot: '/registry/approved-project',
    enabled: true,
  }],
};
const proposal = {
  summary: 'Read-only analysis',
  steps: [{
    id: 'step-1',
    title: 'Inspect',
    objective: 'Inspect approved files only',
    role: 'implementer',
    dependsOn: [],
    requiredCapabilities: ['repository_read'],
  }],
  executionMode: 'direct',
  completionMode: 'analyze',
  requiresHumanApproval: false,
  blockedActions: [],
};
const hermesOk = async () => ({ ok: true, response: JSON.stringify(proposal) });
const codexOk = async () => ({
  success: true,
  executionId: 'execution-123',
  status: 'completed',
  summary: 'Codex completed safely.',
  resultText: 'Useful completion result.',
  outcome: 'modification_completed',
});
const workflowOk = {
  ok: true,
  projectId: 'approved-project',
  executionId: 'exec-safe',
  status: 'analyzed',
  executionSummary: 'hidden',
  resultText: 'Result.',
};
const config = {
  host: '127.0.0.1',
  port: 3014,
  corsOrigins: [],
  agendaSqlitePath: '',
  projectRegistryPath: '',
  hermesRoot: '',
  hermesExecutionEnabled: true,
  hermesExecutable: '/bin/hermes',
  hermesHome: '/hermes',
  hermesUser: 'hermes',
  hermesUserHome: '/home/hermes',
  hermesPath: '/bin',
  hermesProvider: 'fake',
  hermesModel: 'fake',
  hermesTimeoutMs: 100,
  hermesMaxQueryCharacters: 8000,
  logLevel: 'silent',
};

function runnerOptions(store, overrides = {}) {
  return {
    store,
    taskId: TASK_A,
    workerId: 'runner-worker-1',
    config,
    request: intent,
    registry,
    onStage: () => {},
    workflowDependencies: { executeHermes: hermesOk, executeCodex: codexOk },
    ...overrides,
  };
}

async function fixture(fn, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'lia-durable-runner-'));
  const databasePath = join(directory, 'tasks.sqlite');
  let now = options.now ?? 1_000;
  const store = new ProjectTaskSqliteStore({ databasePath, now: () => now });
  store.createOrGet(TASK_A, 'fp-a', intent);
  try {
    await fn({ store, databasePath, setNow(value) { now = value; } });
  } finally {
    if (store.isOpen !== false) store.close();
    await rm(directory, { recursive: true, force: true });
  }
}

function chain(store, taskId = TASK_A, owner = 'pre-worker', durationMs = 10_000) {
  const dispatch = store.enqueueTaskDispatch(taskId);
  const lease = store.claimTaskDispatch({ dispatchId: dispatch.dispatchId, leaseOwner: owner, durationMs }).lease;
  const run = store.prepareTaskExecutionRun({
    dispatchId: dispatch.dispatchId,
    taskId,
    leaseOwner: lease.leaseOwner,
    leaseId: lease.leaseId,
    fencingToken: lease.fencingToken,
  });
  const invocation = store.reserveTaskExecutionInvocation({
    executionRunId: run.executionRunId,
    taskId,
    leaseOwner: lease.leaseOwner,
    leaseId: lease.leaseId,
    fencingToken: lease.fencingToken,
  });
  return { dispatch, lease, run, invocation };
}

function crossBoundary(store, { invocation, run, lease }) {
  return store.beginTaskExecutionLaunchAttempt({
    invocationId: invocation.invocationId,
    executionRunId: run.executionRunId,
    taskId: run.taskId,
    leaseOwner: lease.leaseOwner,
    leaseId: lease.leaseId,
    fencingToken: lease.fencingToken,
  });
}

async function withDurableStore(fn) {
  const directory = await mkdtemp(join(tmpdir(), 'lia-durable-http-'));
  const store = new ProjectTaskSqliteStore({ databasePath: join(directory, 'tasks.sqlite') });
  try {
    await fn(store);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
}

async function server(app, fn) {
  const s = app.listen(0, '127.0.0.1');
  await once(s, 'listening');
  try {
    await fn(`http://127.0.0.1:${s.address().port}`);
  } finally {
    await new Promise((r) => s.close(r));
  }
}

const postTask = (base, body) => fetch(`${base}/api/projects/tasks`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

test('1. durable runner uses accepted tasks and refuses non-accepted tasks before any external phase', async () => {
  await fixture(async ({ store }) => {
    store.transition(TASK_A, 'planning');
    let hermesCalls = 0;
    await assert.rejects(
      runProjectTaskDurableExecution(runnerOptions(store, {
        workflowDependencies: {
          executeHermes: async () => { hermesCalls += 1; return hermesOk(); },
          executeCodex: codexOk,
        },
      })),
      /project_task_durable_execution_task_unavailable/,
    );
    assert.equal(hermesCalls, 0);
    assert.equal(store.readTaskExecutionLaunchAttemptByTask(TASK_A), undefined);
  });
});

test('2. lease is acquired before dispatch is enqueued and before the rest of the durable chain', async () => {
  await fixture(async ({ store }) => {
    const order = [];
    const wrap = (name) => {
      const original = store[name].bind(store);
      store[name] = (...args) => { order.push(name); return original(...args); };
    };
    wrap('acquireTaskLease');
    wrap('enqueueTaskDispatch');
    wrap('claimTaskDispatch');
    wrap('prepareTaskExecutionRun');
    wrap('reserveTaskExecutionInvocation');
    wrap('beginTaskExecutionLaunchAttempt');
    const result = await runProjectTaskDurableExecution(runnerOptions(store, {
      executeWorkflow: async () => workflowOk,
    }));
    assert.equal(result.ok, true);
    assert.deepEqual(order, [
      'acquireTaskLease',
      'enqueueTaskDispatch',
      'claimTaskDispatch',
      'prepareTaskExecutionRun',
      'reserveTaskExecutionInvocation',
      'beginTaskExecutionLaunchAttempt',
    ]);
  });
});

test('3. dispatch is enqueued before run preparation', async () => {
  await fixture(async ({ store }) => {
    const ops = [];
    const originalEnqueue = store.enqueueTaskDispatch.bind(store);
    const originalPrepare = store.prepareTaskExecutionRun.bind(store);
    store.enqueueTaskDispatch = (...args) => { ops.push('enqueue'); return originalEnqueue(...args); };
    store.prepareTaskExecutionRun = (...args) => { ops.push('prepare'); return originalPrepare(...args); };
    const result = await runProjectTaskDurableExecution(runnerOptions(store, {
      executeWorkflow: async () => workflowOk,
    }));
    assert.equal(result.ok, true);
    assert.ok(ops.indexOf('enqueue') < ops.indexOf('prepare'));
  });
});

test('4. exact dispatch claim uses the current lease and fencing tuple', async () => {
  await fixture(async ({ store }) => {
    const result = await runProjectTaskDurableExecution(runnerOptions(store, {
      executeWorkflow: async () => workflowOk,
    }));
    assert.equal(result.ok, true);
    const dispatch = store.readTaskDispatchByTask(TASK_A);
    const run = store.readTaskExecutionRunByTask(TASK_A);
    const lease = store.readTaskLease(TASK_A);
    assert.ok(dispatch && run && lease);
    assert.equal(dispatch.consumedLeaseId, lease.leaseId);
    assert.equal(dispatch.consumedFencingToken, lease.fencingToken);
    assert.equal(run.preparationLeaseId, lease.leaseId);
    assert.equal(run.preparationFencingToken, lease.fencingToken);
    assert.equal(lease.fencingToken, 1);
    assert.equal(lease.leaseOwner, 'runner-worker-1');
  });
});

test('5. prepareRun consumes the dispatch under the existing atomic semantics', async () => {
  await fixture(async ({ store }) => {
    const result = await runProjectTaskDurableExecution(runnerOptions(store, {
      executeWorkflow: async () => workflowOk,
    }));
    assert.equal(result.ok, true);
    const dispatch = store.readTaskDispatchByTask(TASK_A);
    assert.ok(dispatch.consumedAt !== undefined);
    const run = store.readTaskExecutionRunByTask(TASK_A);
    assert.equal(run.dispatchId, dispatch.dispatchId);
    // A second claim of the consumed dispatch is refused by the existing store.
    assert.throws(
      () => store.claimTaskDispatch({ dispatchId: dispatch.dispatchId, leaseOwner: 'other', durationMs: 10_000 }),
      /already_consumed|project_task_dispatch_already_consumed/,
    );
  });
});

test('6. invocation is reserved before the workflow enters its external phase', async () => {
  await fixture(async ({ store }) => {
    let observedAtHermes = false;
    let hermesCalls = 0;
    const result = await runProjectTaskDurableExecution(runnerOptions(store, {
      workflowDependencies: {
        executeHermes: async () => {
          hermesCalls += 1;
          observedAtHermes = store.readTaskExecutionInvocationByTask(TASK_A) !== undefined;
          return hermesOk();
        },
        executeCodex: codexOk,
      },
    }));
    assert.equal(result.ok, true);
    assert.equal(hermesCalls, 1);
    assert.equal(observedAtHermes, true);
    assert.ok(store.readTaskExecutionInvocationByTask(TASK_A) !== undefined);
  });
});

test('7. planning occurs before the Launch Attempt', async () => {
  await fixture(async ({ store }) => {
    const events = [];
    const originalBegin = store.beginTaskExecutionLaunchAttempt.bind(store);
    store.beginTaskExecutionLaunchAttempt = (...args) => {
      events.push('begin');
      return originalBegin(...args);
    };
    const result = await runProjectTaskDurableExecution(runnerOptions(store, {
      onStage: (stage) => { events.push(`stage:${stage}`); },
    }));
    assert.equal(result.ok, true);
    const planning = events.indexOf('stage:planning');
    const begin = events.indexOf('begin');
    assert.ok(planning >= 0 && begin > planning, `events: ${events.join(', ')}`);
  });
});

test('8. no Hermes call happens before the Launch Attempt and the hermes stage follows it', async () => {
  await fixture(async ({ store }) => {
    const events = [];
    const originalBegin = store.beginTaskExecutionLaunchAttempt.bind(store);
    store.beginTaskExecutionLaunchAttempt = (...args) => {
      events.push('begin');
      return originalBegin(...args);
    };
    let hermesCalls = 0;
    const result = await runProjectTaskDurableExecution(runnerOptions(store, {
      onStage: (stage) => { events.push(`stage:${stage}`); },
      workflowDependencies: {
        executeHermes: async () => {
          hermesCalls += 1;
          events.push('hermes-call');
          return hermesOk();
        },
        executeCodex: codexOk,
      },
    }));
    assert.equal(result.ok, true);
    assert.equal(hermesCalls, 1);
    const begin = events.indexOf('begin');
    const hermesStage = events.indexOf('stage:hermes');
    const hermesCall = events.indexOf('hermes-call');
    assert.ok(begin >= 0 && hermesStage > begin && hermesCall > hermesStage, `events: ${events.join(', ')}`);
  });
});

test('9. first valid Launch Attempt permits the live Hermes phase and completes', async () => {
  await fixture(async ({ store }) => {
    let hermesCalls = 0;
    const result = await runProjectTaskDurableExecution(runnerOptions(store, {
      workflowDependencies: {
        executeHermes: async () => { hermesCalls += 1; return hermesOk(); },
        executeCodex: codexOk,
      },
    }));
    assert.equal(result.ok, true);
    assert.equal(result.status, 'analyzed');
    assert.equal(hermesCalls, 1);
    const attempt = store.readTaskExecutionLaunchAttemptByTask(TASK_A);
    assert.ok(attempt !== undefined);
    assert.equal(attempt.invocationId, store.readTaskExecutionInvocationByTask(TASK_A).invocationId);
    assert.equal(store.get(TASK_A).status, 'accepted');
  });
});

test('10. observable hermes stage occurs only after a successful gate', async () => {
  await fixture(async ({ store }) => {
    // Happy path: stage hermes follows the durable crossing.
    const happyEvents = [];
    const originalBegin = store.beginTaskExecutionLaunchAttempt.bind(store);
    store.beginTaskExecutionLaunchAttempt = (...args) => {
      happyEvents.push('begin');
      return originalBegin(...args);
    };
    await runProjectTaskDurableExecution(runnerOptions(store, {
      onStage: (stage) => { happyEvents.push(`stage:${stage}`); },
    }));
    assert.ok(happyEvents.indexOf('begin') < happyEvents.indexOf('stage:hermes'));

    // Gate rejection: the hermes stage is never observed and Hermes never runs.
    store.createOrGet(TASK_B, 'fp-b', intent);
    const { run, lease, invocation } = chain(store, TASK_B, 'pre-worker');
    crossBoundary(store, { invocation, run, lease });
    let hermesCalls = 0;
    const rejectedEvents = [];
    const result = await runProjectTaskDurableExecution(runnerOptions(store, {
      taskId: TASK_B,
      onStage: (stage) => { rejectedEvents.push(`stage:${stage}`); },
      workflowDependencies: {
        executeHermes: async () => { hermesCalls += 1; return hermesOk(); },
        executeCodex: codexOk,
      },
    }));
    assert.equal(result.ok, false);
    assert.equal(result.error, 'external_launch_outcome_unknown');
    assert.equal(rejectedEvents.includes('stage:hermes'), false);
    assert.equal(hermesCalls, 0);
  });
});

test('11. an existing launch attempt causes zero Hermes calls', async () => {
  await fixture(async ({ store }) => {
    const prepared = chain(store);
    crossBoundary(store, prepared);
    let hermesCalls = 0;
    let codexCalls = 0;
    const result = await runProjectTaskDurableExecution(runnerOptions(store, {
      workflowDependencies: {
        executeHermes: async () => { hermesCalls += 1; return hermesOk(); },
        executeCodex: async () => { codexCalls += 1; return codexOk(); },
      },
    }));
    assert.equal(result.ok, false);
    assert.equal(result.error, 'external_launch_outcome_unknown');
    assert.equal(hermesCalls, 0);
    assert.equal(codexCalls, 0);
    assert.equal(store.listTaskExecutionLaunchAttempts(10).length, 1);
  });
});

test('12. created=false from the boundary causes zero Hermes calls', async () => {
  await fixture(async ({ store }) => {
    // During planning (inside the live workflow) another instance crosses the
    // boundary using the runner's own chain; the runner's begin then reports
    // created=false and must not enter Hermes.
    const registryWithRacingCrossing = {
      read: async () => {
        const lease = store.readTaskLease(TASK_A);
        const run = store.readTaskExecutionRunByTask(TASK_A);
        const invocation = store.readTaskExecutionInvocationByTask(TASK_A);
        const crossing = crossBoundary(store, { invocation, run, lease });
        assert.equal(crossing.created, true);
        return [{ projectId: 'approved-project', displayName: 'Approved Project', repositoryRoot: '/registry/approved-project', enabled: true }];
      },
    };
    let hermesCalls = 0;
    const result = await runProjectTaskDurableExecution(runnerOptions(store, {
      registry: registryWithRacingCrossing,
      workflowDependencies: {
        executeHermes: async () => { hermesCalls += 1; return hermesOk(); },
        executeCodex: codexOk,
      },
    }));
    assert.equal(result.ok, false);
    assert.equal(result.error, 'external_launch_outcome_unknown');
    assert.equal(hermesCalls, 0);
    assert.equal(store.listTaskExecutionLaunchAttempts(10).length, 1);
  });
});

test('13. a stale/released lease causes zero Hermes calls', async () => {
  await fixture(async ({ store }) => {
    const registryReleasingLease = {
      read: async () => {
        const lease = store.readTaskLease(TASK_A);
        store.releaseTaskLease({
          taskId: TASK_A,
          leaseOwner: lease.leaseOwner,
          leaseId: lease.leaseId,
          fencingToken: lease.fencingToken,
        });
        return [{ projectId: 'approved-project', displayName: 'Approved Project', repositoryRoot: '/registry/approved-project', enabled: true }];
      },
    };
    let hermesCalls = 0;
    await assert.rejects(
      runProjectTaskDurableExecution(runnerOptions(store, {
        registry: registryReleasingLease,
        workflowDependencies: {
          executeHermes: async () => { hermesCalls += 1; return hermesOk(); },
          executeCodex: codexOk,
        },
      })),
      /project_task_lease_/,
    );
    assert.equal(hermesCalls, 0);
    assert.equal(store.readTaskExecutionLaunchAttemptByTask(TASK_A), undefined);
  });
});

test('14. a wrong fencing generation causes zero Hermes calls', async () => {
  await fixture(async ({ store, setNow }) => {
    const registryWithNewerGeneration = {
      read: async () => {
        setNow(400_000); // expire the runner lease
        store.acquireTaskLease({ taskId: TASK_A, leaseOwner: 'competitor', durationMs: 10_000 });
        return [{ projectId: 'approved-project', displayName: 'Approved Project', repositoryRoot: '/registry/approved-project', enabled: true }];
      },
    };
    let hermesCalls = 0;
    await assert.rejects(
      runProjectTaskDurableExecution(runnerOptions(store, {
        registry: registryWithNewerGeneration,
        workflowDependencies: {
          executeHermes: async () => { hermesCalls += 1; return hermesOk(); },
          executeCodex: codexOk,
        },
      })),
      /project_task_lease_/,
    );
    assert.equal(hermesCalls, 0);
    assert.equal(store.readTaskExecutionLaunchAttemptByTask(TASK_A), undefined);
    assert.equal(store.readTaskLease(TASK_A).fencingToken, 2);
  });
});

test('15. an expired lease cannot first-launch', async () => {
  await fixture(async ({ store, setNow }) => {
    const registryAdvancingClock = {
      read: async () => {
        setNow(400_000);
        return [{ projectId: 'approved-project', displayName: 'Approved Project', repositoryRoot: '/registry/approved-project', enabled: true }];
      },
    };
    let hermesCalls = 0;
    await assert.rejects(
      runProjectTaskDurableExecution(runnerOptions(store, {
        registry: registryAdvancingClock,
        workflowDependencies: {
          executeHermes: async () => { hermesCalls += 1; return hermesOk(); },
          executeCodex: codexOk,
        },
      })),
      /project_task_lease_/,
    );
    assert.equal(hermesCalls, 0);
    assert.equal(store.readTaskExecutionLaunchAttemptByTask(TASK_A), undefined);
  });
});

test('16. a newer valid lease generation may first-launch when Layer 10 permits it', async () => {
  await fixture(async ({ store, setNow }) => {
    store.acquireTaskLease({ taskId: TASK_A, leaseOwner: 'old-worker', durationMs: 1_000 });
    setNow(5_000); // old generation expired before any dispatch/run existed
    let hermesCalls = 0;
    const result = await runProjectTaskDurableExecution(runnerOptions(store, {
      workflowDependencies: {
        executeHermes: async () => { hermesCalls += 1; return hermesOk(); },
        executeCodex: codexOk,
      },
    }));
    assert.equal(result.ok, true);
    assert.equal(hermesCalls, 1);
    const lease = store.readTaskLease(TASK_A);
    assert.equal(lease.leaseOwner, 'runner-worker-1');
    assert.equal(lease.fencingToken, 2);
    assert.ok(store.readTaskExecutionLaunchAttemptByTask(TASK_A) !== undefined);
  });
});

test('17. concurrent duplicate runner attempts converge safely', async () => {
  await fixture(async ({ store }) => {
    const releasePlanning = deferred();
    const slowRegistry = {
      read: async () => {
        await releasePlanning.promise;
        return [{ projectId: 'approved-project', displayName: 'Approved Project', repositoryRoot: '/registry/approved-project', enabled: true }];
      },
    };
    let hermesCalls = 0;
    const first = runProjectTaskDurableExecution(runnerOptions(store, {
      workerId: 'runner-a',
      registry: slowRegistry,
      workflowDependencies: {
        executeHermes: async () => { hermesCalls += 1; return hermesOk(); },
        executeCodex: codexOk,
      },
    }));
    // The first runner's durable chain is synchronous, so its lease exists now.
    assert.ok(store.readTaskLease(TASK_A) !== undefined);
    await assert.rejects(
      runProjectTaskDurableExecution(runnerOptions(store, {
        workerId: 'runner-b',
        workflowDependencies: {
          executeHermes: async () => { hermesCalls += 1; return hermesOk(); },
          executeCodex: codexOk,
        },
      })),
      /project_task_lease_unavailable/,
    );
    releasePlanning.resolve();
    const result = await first;
    assert.equal(result.ok, true);
    assert.equal(hermesCalls, 1);
    assert.equal(store.listTaskExecutionLaunchAttempts(10).length, 1);
  });
});

test('18. a competitor worker cannot externally launch', async () => {
  await fixture(async ({ store }) => {
    store.acquireTaskLease({ taskId: TASK_A, leaseOwner: 'competitor', durationMs: 10_000 });
    let hermesCalls = 0;
    await assert.rejects(
      runProjectTaskDurableExecution(runnerOptions(store, {
        workflowDependencies: {
          executeHermes: async () => { hermesCalls += 1; return hermesOk(); },
          executeCodex: codexOk,
        },
      })),
      /project_task_lease_unavailable/,
    );
    assert.equal(hermesCalls, 0);
    assert.equal(store.readTaskExecutionLaunchAttemptByTask(TASK_A), undefined);
  });
});

test('19. a throw before the Launch Attempt produces no attempt record', async () => {
  await fixture(async ({ store }) => {
    const failingRegistry = {
      read: async () => { throw new Error('PRIVATE planning failure'); },
    };
    let hermesCalls = 0;
    const result = await runProjectTaskDurableExecution(runnerOptions(store, {
      registry: failingRegistry,
      workflowDependencies: {
        executeHermes: async () => { hermesCalls += 1; return hermesOk(); },
        executeCodex: codexOk,
      },
    }));
    assert.equal(result.ok, false);
    assert.equal(result.stage, 'planning');
    assert.equal(hermesCalls, 0);
    assert.equal(store.readTaskExecutionLaunchAttemptByTask(TASK_A), undefined);
  });
});

test('20. a throw immediately after the Launch Attempt leaves durable ambiguity evidence', async () => {
  await fixture(async ({ store }) => {
    let hermesCalls = 0;
    const result = await runProjectTaskDurableExecution(runnerOptions(store, {
      executeWorkflow: async () => { throw new Error('PRIVATE crash'); },
      workflowDependencies: {
        executeHermes: async () => { hermesCalls += 1; return hermesOk(); },
        executeCodex: codexOk,
      },
    }));
    assert.equal(result.ok, false);
    assert.equal(result.error, 'external_launch_outcome_unknown');
    assert.equal(result.stage, 'hermes');
    assert.equal(hermesCalls, 0);
    const attempt = store.readTaskExecutionLaunchAttemptByTask(TASK_A);
    assert.ok(attempt !== undefined);
  });
});

test('21. replay after a simulated crash does not call Hermes', async () => {
  await fixture(async ({ store }) => {
    const prepared = chain(store);
    crossBoundary(store, prepared);
    let hermesCalls = 0;
    const result = await runProjectTaskDurableExecution(runnerOptions(store, {
      workflowDependencies: {
        executeHermes: async () => { hermesCalls += 1; return hermesOk(); },
        executeCodex: codexOk,
      },
    }));
    assert.equal(result.ok, false);
    assert.equal(result.error, 'external_launch_outcome_unknown');
    assert.equal(hermesCalls, 0);
    assert.equal(store.listTaskExecutionLaunchAttempts(10).length, 1);
  });
});

test('22. DB reopen with a Launch Attempt does not call Hermes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lia-durable-reopen-'));
  const databasePath = join(directory, 'tasks.sqlite');
  try {
    const first = new ProjectTaskSqliteStore({ databasePath, now: () => 1_000 });
    first.createOrGet(TASK_A, 'fp-a', intent);
    const prepared = chain(first);
    crossBoundary(first, prepared);
    first.close();

    const reopened = new ProjectTaskSqliteStore({ databasePath, now: () => 2_000 });
    try {
      let hermesCalls = 0;
      const result = await runProjectTaskDurableExecution(runnerOptions(reopened, {
        workflowDependencies: {
          executeHermes: async () => { hermesCalls += 1; return hermesOk(); },
          executeCodex: codexOk,
        },
      }));
      assert.equal(result.ok, false);
      assert.equal(result.error, 'external_launch_outcome_unknown');
      assert.equal(hermesCalls, 0);
    } finally {
      reopened.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('23. the safe error is external_launch_outcome_unknown with its safe public message', async () => {
  await fixture(async ({ store }) => {
    const prepared = chain(store);
    crossBoundary(store, prepared);
    const result = await runProjectTaskDurableExecution(runnerOptions(store));
    assert.equal(result.ok, false);
    assert.equal(result.stage, 'hermes');
    assert.equal(result.error, 'external_launch_outcome_unknown');
    assert.equal(
      SAFE_TASK_ERROR_MESSAGES.external_launch_outcome_unknown,
      'El lanzamiento externo quedó interrumpido y su resultado es desconocido; LÍA no lo relanza automáticamente.',
    );
  });
});

test('24. route public receipts leak no lease/run/invocation/launch IDs', async () => {
  await withDurableStore(async (store) => {
    const app = createApp(loadConfig({}), {
      projectRegistrySource: registry,
      projectTaskStore: store,
      projectTasksWorkflowExecutor: async () => workflowOk,
    });
    await server(app, async (base) => {
      const body = { taskId: TASK_A, projectId: 'approved-project', instruction: 'Inspect.', priority: 'normal', requestedCapabilities: ['repository_read'] };
      assert.equal((await postTask(base, body)).status, 202);
      await new Promise(setImmediate);
      const response = await (await fetch(`${base}/api/projects/tasks/${TASK_A}`)).json();
      assert.equal(response.status, 'completed');
      assert.equal(response.receipt.executionId, 'exec-safe');
      const attempt = store.readTaskExecutionLaunchAttemptByTask(TASK_A);
      const invocation = store.readTaskExecutionInvocationByTask(TASK_A);
      const run = store.readTaskExecutionRunByTask(TASK_A);
      const dispatch = store.readTaskDispatchByTask(TASK_A);
      const lease = store.readTaskLease(TASK_A);
      assert.ok(attempt && invocation && run && dispatch && lease);
      const publicText = JSON.stringify(response);
      for (const identifier of [
        attempt.launchAttemptId,
        invocation.invocationId,
        run.executionRunId,
        dispatch.dispatchId,
        lease.leaseId,
        lease.leaseOwner,
      ]) {
        assert.equal(publicText.includes(identifier), false, identifier);
      }
      for (const forbidden of ['/registry/approved-project', 'hidden', 'runner-']) {
        assert.equal(publicText.includes(forbidden), false, forbidden);
      }
    });
  });
});

test('25. the route contains no duplicated durable algorithm', async () => {
  const source = await readFile(new URL('../src/routes/projectTasks.ts', import.meta.url), 'utf8');
  for (const primitive of [
    'acquireTaskLease(',
    'enqueueTaskDispatch(',
    'claimTaskDispatch(',
    'prepareTaskExecutionRun(',
    'reserveTaskExecutionInvocation(',
    'beginTaskExecutionLaunchAttempt(',
  ]) {
    assert.equal(source.includes(primitive), false, primitive);
  }
  assert.equal(source.includes('runProjectTaskDurableExecution'), true);
  assert.equal(source.includes('randomUUID'), true);
});

test('26. product path with a non-durable store fails closed before Hermes', async () => {
  const store = new InMemoryProjectTaskStore();
  let workflowCalls = 0;
  const app = createApp(loadConfig({}), {
    projectRegistrySource: registry,
    projectTaskStore: store,
    projectTasksWorkflowExecutor: async () => {
      workflowCalls += 1;
      return workflowOk;
    },
  });
  await server(app, async (base) => {
    const body = { taskId: TASK_A, projectId: 'approved-project', instruction: 'Inspect.', priority: 'normal', requestedCapabilities: ['repository_read'] };
    assert.equal((await postTask(base, body)).status, 202);
    await new Promise(setImmediate);
    const response = await (await fetch(`${base}/api/projects/tasks/${TASK_A}`)).json();
    assert.equal(response.status, 'failed');
    assert.deepEqual(response.error, { code: 'workflow_failed', message: SAFE_TASK_ERROR_MESSAGES.workflow_failed });
    assert.equal(workflowCalls, 0);
  });
});

test('27. the SQLite durable store is accepted by the capability guard and the in-memory fallback is not', async () => {
  await withDurableStore(async (store) => {
    assert.equal(hasProjectTaskDurableExecutionPrimitives(store), true);
    assert.equal(hasProjectTaskDurableExecutionPrimitives(new InMemoryProjectTaskStore()), false);
  });
});

test('28. no capability/authority expansion in the runner or its composite store', async () => {
  const runnerSource = await readFile(new URL('../src/services/projectTaskDurableExecutionRunner.ts', import.meta.url), 'utf8');
  const contractSource = await readFile(new URL('../src/contracts/projectTaskDurableExecution.ts', import.meta.url), 'utf8');
  // Layer 14 resume decisions reference approvedCapabilities and
  // effectiveCapabilities in policy fingerprinting and capability resolution
  // contexts only — they are inert metadata, not authority grants. The guard
  // still forbids execution side channels (shell, exec, spawn, eval) and
  // process-spawning imports.
  for (const source of [runnerSource, contractSource]) {
    assert.doesNotMatch(source, /\b(shell|exec\(|spawn\(|eval\()/);
    assert.doesNotMatch(source, /child_process|execSync|runuser/i);
  }
  // The composite store capability is a pure intersection of the existing
  // store interfaces: it declares no authority/provenance fields of its own.
  const composite = contractSource.slice(
    contractSource.indexOf('export type ProjectTaskDurableExecutionStore'),
    contractSource.indexOf('export const PROJECT_TASK_DURABLE_EXECUTION_ERRORS'),
  );
  for (const field of ['leaseOwner', 'fencingToken', 'leaseId', 'taskId', 'capabilities', 'role']) {
    assert.equal(composite.includes(field), false, field);
  }
});

test('29. the durable runner and its contract introduce no schema at V16 (schema lives in the schema module)', async () => {
  assert.equal(PROJECT_TASK_SQLITE_SCHEMA_VERSION, 18);
  const runnerSource = await readFile(new URL('../src/services/projectTaskDurableExecutionRunner.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(runnerSource, /CREATE\s+(TABLE|TRIGGER|INDEX)/i);
  const contractSource = await readFile(new URL('../src/contracts/projectTaskDurableExecution.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(contractSource, /CREATE\s+(TABLE|TRIGGER|INDEX)/i);
});

test('30. the direct /api/projects/tasks/workflow legacy path remains compatible', async () => {
  const app = createApp(loadConfig({}), {
    projectRegistrySource: registry,
    projectTaskWorkflowExecutor: async () => workflowOk,
  });
  await server(app, async (base) => {
    const response = await fetch(`${base}/api/projects/tasks/workflow`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(intent),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.executionId, 'exec-safe');
    assert.equal(body.status, 'analyzed');
  });
});

test('31. Hermes initial plus the existing bounded repair in the same admitted live workflow creates one Launch Attempt', async () => {
  await fixture(async ({ store }) => {
    const responses = [
      { ok: true, response: 'not-json' },
      { ok: true, response: JSON.stringify(proposal) },
    ];
    let hermesCalls = 0;
    const result = await runProjectTaskDurableExecution(runnerOptions(store, {
      workflowDependencies: {
        executeHermes: async () => { hermesCalls += 1; return responses.shift(); },
        executeCodex: codexOk,
      },
    }));
    assert.equal(result.ok, true);
    assert.equal(hermesCalls, 2); // initial + bounded repair, both inside ONE live workflow
    assert.equal(store.listTaskExecutionLaunchAttempts(10).length, 1);
  });
});

test('32. a restarted/re-entered workflow cannot reuse the repair behavior as a retry', async () => {
  await fixture(async ({ store }) => {
    const prepared = chain(store);
    crossBoundary(store, prepared);
    const responses = [
      { ok: true, response: 'not-json' },
      { ok: true, response: JSON.stringify(proposal) },
    ];
    let hermesCalls = 0;
    const result = await runProjectTaskDurableExecution(runnerOptions(store, {
      workflowDependencies: {
        executeHermes: async () => { hermesCalls += 1; return responses.shift(); },
        executeCodex: codexOk,
      },
    }));
    assert.equal(result.ok, false);
    assert.equal(result.error, 'external_launch_outcome_unknown');
    assert.equal(hermesCalls, 0);
    assert.equal(store.listTaskExecutionLaunchAttempts(10).length, 1);
  });
});

test('33. Codex cannot begin unless the admitted Hermes phase returns successfully', async () => {
  await fixture(async ({ store }) => {
    // Hermes fails every retry: Codex must never start.
    let hermesCalls = 0;
    let codexCalls = 0;
    const result = await runProjectTaskDurableExecution(runnerOptions(store, {
      workflowDependencies: {
        executeHermes: async () => {
          hermesCalls += 1;
          return { ok: false, error: 'execution_failed' };
        },
        executeCodex: async () => { codexCalls += 1; return codexOk(); },
      },
    }));
    assert.equal(result.ok, false);
    assert.equal(result.stage, 'hermes');
    assert.equal(hermesCalls, 2);
    assert.equal(codexCalls, 0);

    // Happy path: Codex runs exactly once after the admitted Hermes phase.
    store.createOrGet(TASK_B, 'fp-b', intent);
    let happyCodexCalls = 0;
    const happy = await runProjectTaskDurableExecution(runnerOptions(store, {
      taskId: TASK_B,
      workflowDependencies: {
        executeHermes: hermesOk,
        executeCodex: async () => { happyCodexCalls += 1; return codexOk(); },
      },
    }));
    assert.equal(happy.ok, true);
    assert.equal(happyCodexCalls, 1);
  });
});

test('34. task completion/failure logic remains safe through the route', async () => {
  await withDurableStore(async (store) => {
    const successApp = createApp(loadConfig({}), {
      projectRegistrySource: registry,
      projectTaskStore: store,
      projectTasksWorkflowExecutor: async () => workflowOk,
    });
    await server(successApp, async (base) => {
      const body = { taskId: TASK_A, projectId: 'approved-project', instruction: 'Inspect.', priority: 'normal', requestedCapabilities: ['repository_read'] };
      await postTask(base, body);
      await new Promise(setImmediate);
      const response = await (await fetch(`${base}/api/projects/tasks/${TASK_A}`)).json();
      assert.equal(response.status, 'completed');
      assert.equal(response.receipt.status, 'analyzed');
      assert.equal(response.terminal, true);
    });

    const failureApp = createApp(loadConfig({}), {
      projectRegistrySource: registry,
      projectTaskStore: store,
      projectTasksWorkflowExecutor: async () => ({
        ok: false,
        status: 'failed',
        stage: 'hermes',
        error: 'execution_failed',
        summary: 'PRIVATE',
        projectId: 'approved-project',
      }),
    });
    await server(failureApp, async (base) => {
      const body = { taskId: TASK_B, projectId: 'approved-project', instruction: 'Inspect.', priority: 'normal', requestedCapabilities: ['repository_read'] };
      await postTask(base, body);
      await new Promise(setImmediate);
      const response = await (await fetch(`${base}/api/projects/tasks/${TASK_B}`)).json();
      assert.equal(response.status, 'failed');
      assert.deepEqual(response.error, {
        stage: 'hermes',
        code: 'execution_failed',
        message: SAFE_TASK_ERROR_MESSAGES.execution_failed,
        projectId: 'approved-project',
      });
      assert.equal(JSON.stringify(response).includes('PRIVATE'), false);
    });
  });
});

test('35. Layer 10 recovery behavior remains unchanged', async () => {
  await fixture(async ({ store }) => {
    // Accepted task with a Launch Attempt fails closed at recovery with the
    // exact Layer 10 ambiguous-launch safe error; pre-launch recoverable work
    // is preserved exactly as before.
    const prepared = chain(store);
    crossBoundary(store, prepared);
    store.createOrGet(TASK_B, 'fp-b', intent);
    const pending = store.enqueueTaskDispatch(TASK_B);
    assert.deepEqual(store.reconcileRestartSafeTasks(), {
      preservedRecoverable: 1,
      failedInterrupted: 1,
      terminalUnchanged: 0,
      resumableAvailable: 0,
    });
    assert.equal(store.get(TASK_A).status, 'failed');
    assert.deepEqual(store.get(TASK_A).error, {
      code: 'external_launch_outcome_unknown',
      message: SAFE_TASK_ERROR_MESSAGES.external_launch_outcome_unknown,
    });
    assert.equal(store.get(TASK_B).status, 'accepted');
    assert.deepEqual(store.readTaskDispatch(pending.dispatchId), pending);
  });
});

test('36. no production/deploy/push/merge integration is introduced', async () => {
  const sources = [
    '../src/services/projectTaskDurableExecutionRunner.ts',
    '../src/contracts/projectTaskDurableExecution.ts',
    '../src/routes/projectTasks.ts',
  ];
  for (const path of sources) {
    const source = await readFile(new URL(path, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /\b(push|merge|deploy|production_write|database_write|secret_access)\b/);
    assert.doesNotMatch(source, /(pm2|nginx|iptables|ufw|systemctl|docker\s+compose)/i);
  }
});

test('durable runner entry rejects a store without the durable primitives', async () => {
  const store = new InMemoryProjectTaskStore();
  await assert.rejects(
    runProjectTaskDurableExecution(runnerOptions(store)),
    /project_task_durable_execution_store_unsupported/,
  );
});

test('durable runner never fabricates a successful hermes stage when the gate rejects', async () => {
  await fixture(async ({ store }) => {
    const prepared = chain(store);
    crossBoundary(store, prepared);
    const stages = [];
    const result = await runProjectTaskDurableExecution(runnerOptions(store, {
      onStage: (stage) => { stages.push(stage); },
    }));
    assert.equal(result.ok, false);
    assert.equal(stages.includes('hermes'), false);
    assert.equal(stages.includes('codex'), false);
  });
});

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

test('runner instances created directly are gated the same way', async () => {
  await fixture(async ({ store }) => {
    const runner = createProjectTaskDurableExecutionRunner(runnerOptions(store, {
      executeWorkflow: async () => workflowOk,
    }));
    const result = await runner.run();
    assert.equal(result.ok, true);
    assert.ok(store.readTaskExecutionLaunchAttemptByTask(TASK_A) !== undefined);
  });
});
