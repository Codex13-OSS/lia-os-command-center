# Office V2 leaf telemetry gap and future boundary

Status: not implemented.

The current Hermes execution path exposes durable task stages and a validated proposal snapshot, but it does not expose reliable lifecycle events for each delegated leaf. Office V2 therefore treats proposal roles and DAG edges as `planned`/`queued` metadata only. It never labels a leaf as executing.

A future producer-owned boundary may append these events only after Hermes has a durable leaf lifecycle source:

```text
OfficeLeafEvent {
  version: "office-leaf-event-v1"
  eventId: string
  taskId: string
  stepId: string
  role: architect | implementer | reviewer | researcher | orchestrator
  type: leaf.started | leaf.stage_changed | leaf.finished
  state: implementing | verifying | reviewing | completed | failed | waiting_human
  occurredAt: integer
}
```

Constraints:

- append-only, idempotent by `eventId`, and bound to an existing durable `taskId` plus validated `stepId`;
- no authority or capabilities; consuming an event can never launch, approve, retry, or write task state;
- no prompt, model output, command, path, session/provider identifier, credential, secret, or capability field;
- unknown, out-of-order, contradictory, or unbound events fail closed and do not appear as activity;
- the Office read model remains useful without this boundary and advertises `leafEventsAvailable: false` until the producer and durable store exist.
