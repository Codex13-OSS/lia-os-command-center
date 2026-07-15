# LIA Agent Backend Deploy Controller

Controlled tooling for a future authorized backend runtime switch from the legacy PM2 script `server.mjs` to the TypeScript build `dist/server.js`.

This directory is tooling only. It does not deploy anything by itself unless `--apply` is called with an explicit request authorization.

## Commands

```bash
node scripts/lia-agent-backend/deploy-controller.mjs --dry-run --request /absolute/request.json
node scripts/lia-agent-backend/deploy-controller.mjs --apply --request /absolute/request.json
node scripts/lia-agent-backend/deploy-controller.mjs --rollback --request /absolute/request.json
```

## Safety Model

- `--dry-run` is read-only.
- `--apply` requires `applyAuthorization` equal to `APPLY:lia-agent-backend:<operationId>`.
- Values are restricted by allowlist: repo root, source backend, deploy dir, backup root, PM2 process, host, port, scripts, health/status paths, and protected ports.
- Paths must be absolute, traversal-free, and symlink-free.
- Commands use `execFile` with argument arrays and `shell: false`.
- PM2 state is inspected with `pm2 jlist`; the controller parses JSON directly and never uses shell, grep, jq, PM2 ids, `pm2 delete all`, or `pm2 kill`.
- The only authorized PM2 process name is `lia-agent-backend`. Duplicate PM2 entries with that name fail closed.
- PM2 stop is idempotent: the controller deletes `lia-agent-backend` only when `pm2 jlist` shows it is present, then rechecks that it is absent.
- Runtime start is separate from stop. Start runs `pm2 start <script> --name lia-agent-backend --interpreter node` from `deployDir` and does not run `pm2 delete`.
- After start, PM2 is rechecked for exactly one `lia-agent-backend`, online status, expected script path, and expected cwd when PM2 exposes it.
- The live deploy directory is not recursively deleted during normal apply.
- The target release is prepared and validated before PM2 is stopped or the live deploy path is changed.
- The controller validates that `deployDir`, `backupRoot`, and the prepared release are on the same filesystem before the live swap.
- The backup is the original live directory moved with `rename(deployDir, backupDir)`.
- The target release becomes live with `rename(releaseDir, deployDir)`, not copy plus remove.
- Rollback restores the original runtime with `rename(backupDir, deployDir)`.
- If automatic rollback is needed after a target release became live, the failed release is moved under `backupRoot` as evidence instead of being deleted.
- `pm2 save` runs only after apply or rollback verification succeeds.

The dry-run plan explicitly lists:

- `prepare-release`
- `validate-same-filesystem`
- `validate-backup-destination-absent`
- `inspect-authorized-pm2-process`
- `stop-authorized-pm2-process-if-present`
- `atomic-rename-live-to-backup`
- `atomic-rename-release-to-live`
- `start-target-runtime-without-delete`
- `verify-pm2-target-state`
- `verify-target`
- `automatic-rollback-stop-if-present`
- `start-original-runtime-without-delete`
- `automatic-rollback-by-rename`
- `pm2-save-after-success`

## Tests

```bash
node --check scripts/lia-agent-backend/deploy-controller.mjs
node --test scripts/lia-agent-backend/tests/deploy-controller.test.mjs
```

The tests use temporary fixtures and a fake command runner that models PM2 presence, status, script, cwd, and version. It returns `[]` when the process is absent, fails a second delete, rejects duplicate starts, and records starts/deletes without touching real PM2.

No real `--apply`, real `--rollback`, real deploy, PM2 operation, or write to `/opt/lia-agent-backend` was executed for this tooling update. `/opt/lia-agent-backups` was not created.
