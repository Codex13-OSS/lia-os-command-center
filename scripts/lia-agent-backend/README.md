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
- Runtime start does not inherit the full root environment. Before `pm2 start`, the controller builds a new PM2 environment from a fixed allowlist, validates it, and passes only that object to the runner.
- After start, PM2 is rechecked for exactly one `lia-agent-backend`, online status, expected script path, and a present cwd exactly equal to `deployDir`.
- The live deploy directory is not recursively deleted during normal apply.
- The target release is prepared and validated before PM2 is stopped or the live deploy path is changed.
- There is a guarded pre-swap window after `pm2 delete lia-agent-backend` and before the first `rename(deployDir, backupDir)`. If apply fails in that window, the original backend is recovered in-place from the still-existing `deployDir`; the controller does not move, copy, or remove `deployDir`.
- In-place recovery revalidates `deployDir` with `lstat` and `realpath`, rejects symlinks, confirms `server.mjs`, confirms package version `v4.4.0-b`, inspects PM2 with `pm2 jlist`, avoids duplicate starts only when the original runtime is already online with the expected script and a present cwd exactly equal to `deployDir`, and restarts only the authorized process when it is absent or wrong. Missing, empty, or different PM2 cwd is non-conforming.
- In-place recovery verifies PM2 online state, script, cwd exactly equal to `deployDir`, `GET /health` 200, version `v4.4.0-b`, `POST /health` 405, missing-route 404, loopback port `127.0.0.1:3014`, frontend `3004`, and generator `3023` before `pm2 save`. The legacy `v4.4.0-b` runtime does not require `GET /api/status` 200; the TypeScript target `v4.10.0-a` still requires `GET /api/status` 200.
- The controller validates that `deployDir`, `backupRoot`, and the prepared release are on the same filesystem before the live swap.
- The backup is the original live directory moved with `rename(deployDir, backupDir)`.
- The target release becomes live with `rename(releaseDir, deployDir)`, not copy plus remove.
- Rollback by rename is separate from pre-swap recovery: rollback restores the original runtime with `rename(backupDir, deployDir)` only after the live directory was already moved to backup.
- If automatic rollback is needed after a target release became live, the failed release is moved under `backupRoot` as evidence instead of being deleted.
- `pm2 save` runs only after apply, rollback, or original-runtime recovery verification succeeds, including unique PM2 process, online state, expected script, exact cwd, applicable HTTP checks, loopback binding, frontend, and generator checks.

The dry-run plan explicitly lists:

- `prepare-release`
- `validate-same-filesystem`
- `validate-pm2-environment-allowlist`
- `validate-backup-destination-absent`
- `inspect-authorized-pm2-process`
- `stop-authorized-pm2-process-if-present`
- `recover-original-runtime-in-place-if-pre-swap-failure`
- `atomic-rename-live-to-backup`
- `atomic-rename-release-to-live`
- `start-target-runtime-without-delete`
- `verify-pm2-target-state`
- `verify-target`
- `automatic-rollback-stop-if-present`
- `start-original-runtime-without-delete`
- `automatic-rollback-by-rename`
- `pm2-save-after-success`

## PM2 Environment

Operational variables are copied only when already present and only by exact name:

- `PATH`
- `HOME`
- `USER`
- `LOGNAME`
- `SHELL`
- `PM2_HOME`
- `LANG`
- `LC_ALL`
- `LC_CTYPE`
- `TZ`
- `TMPDIR`

Functional variables are fixed explicitly:

- `LIA_AGENT_HOST=127.0.0.1`
- `LIA_AGENT_PORT=3014`
- `LIA_AGENT_CORS_ORIGINS=`
- `LIA_AGENT_LOG_LEVEL=info`
- `NODE_ENV=production`

Unknown variables are blocked. The controller does not propagate `NODE_OPTIONS`, `NODE_PATH`, provider credentials, database URLs, GitHub tokens, or variables ending in `_KEY`, `_TOKEN`, `_SECRET`, or `_PASSWORD`. Reports may list allowed key names, but do not print inherited values.

## Tests

```bash
node --check scripts/lia-agent-backend/deploy-controller.mjs
node --test scripts/lia-agent-backend/tests/deploy-controller.test.mjs
```

The tests use temporary fixtures and a fake command runner that models PM2 presence, status, script path, cwd presence, incorrect cwd, missing cwd after start, save failure, and version independently. It returns `[]` when the process is absent, fails a second delete, rejects duplicate starts, and records starts/deletes without touching real PM2.

No real `--apply`, real `--rollback`, real deploy, real dry-run against the live environment, PM2 operation, or write to `/opt/lia-agent-backend` was executed for this tooling update. `/opt/lia-agent-backups` was not created.

R3 real dry-run passed 19/19 checks before this R4 hardening. After this commit is reviewed, the real dry-run must be repeated before any controlled apply is considered.

<!-- BEGIN LIA-AGENT-BACKEND-D7-DURABLE-CLOSEOUT -->
## D7 — Cierre del despliegue controlado R5

### Estado vigente

La operación `lia-agent-backend-d7-apply-r5-001` quedó completada, desplegada y validada.

- Backend activo: `v4.10.0-a`.
- Proceso PM2: `lia-agent-backend`, único y `online`.
- Script: `/opt/lia-agent-backend/dist/server.js`.
- CWD: `/opt/lia-agent-backend`.
- Listener: exclusivamente `127.0.0.1:3014`.
- `GET /health`: 200 y versión `v4.10.0-a`.
- `GET /api/status`: 200.
- `POST /health`: 405.
- Ruta inexistente: 404.
- Frontend 3004: 200.
- Generador 3023: 200.
- Readiness R5: `transient-success`, intento 2 de 6.
- Rollback automático: no ejecutado.
- `pm2 save`: ejecutado únicamente después del éxito completo.

### Evidencia aprobada

- `D7_DRY_RUN_APROBADO`
- `D7_FINAL_APPLY_PREFLIGHT_APROBADO`
- `D7_APPLY_COMPLETADO_Y_VALIDADO`
- `D7_POST_DEPLOY_VALIDACION_READ_ONLY_APROBADA`
- Solicitud durable:
  `/var/lib/lia-agent-deploy/requests/lia-agent-backend-d7-apply-r5-001.json`
- SHA-256:
  `e39a53134aa57515dae5bc365954e65cc103680af07093e10b8c49d8376a6dd5`
- Backup legado:
  `/opt/lia-agent-backups/2026-07-16T00-51-53-408Z-lia-agent-backend-d7-apply-r5-001`
- Versión respaldada: `4.4.0-b`.

### Decisión operativa

El apply D7 fue consumido y no debe repetirse. No se debe ejecutar rollback
manual sin una nueva autorización explícita. El runtime vigente aceptado es
el backend `v4.10.0-a` desplegado mediante el controlador R5.

### Capacidades aún desactivadas

El servicio permanece en modo `read_only_foundation`:

- `realActionsEnabled=false`
- `voiceEnabled=false`
- `whatsappEnabled=false`
- `memoryWriteEnabled=false`
- `externalModelsEnabled=false`
- `frontendConnected=false`
- `secretsLoaded=false`

### Siguiente paso

Diseñar, sin iniciar todavía, una subfase independiente de integración
controlada entre el frontend de LÍA O.S. y el backend local `v4.10.0-a`.

La integración deberá mantener desactivadas las acciones reales, secretos,
escritura de memoria, voz, WhatsApp y modelos externos hasta recibir
autorizaciones separadas, específicas y verificables.
<!-- END LIA-AGENT-BACKEND-D7-DURABLE-CLOSEOUT -->
