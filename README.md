# LÍA O.S. / Hermes (lia-hermes)

Plataforma ejecutiva de coordinación con autonomía funcional: desde la
interfaz de **Proyectos** el usuario envía una instrucción real y LÍA la
ejecuta de extremo a extremo mediante **LÍA -> Hermes Supervisor -> Codex ->
verificación -> commit local**, mostrando un resultado visible y verificable.

## Estructura

- `frontend/` — UI ejecutiva (React + Vite). La vista de Proyectos envía la
  instrucción al prefijo same-origin `/api/lia-agent/...`.
- `backend/lia-agent/` — backend TypeScript/Express real. Expone el flujo de
  tareas de proyecto bajo `/api/projects/tasks` (aceptación async con
  `taskId` + `GET /api/projects/tasks/:taskId` para estado/resultado) y
  `/api/hermes/query` para consultas de Hermes.
- `scripts/` — runtime same-origin de producción (`lia-production-same-origin-runtime-server.mjs`)
  y validaciones controladas.
- `docs/` — contrato y evidencia por fase.

## Traducción de prefijos (frontend/proxy)

La UI usa `/api/lia-agent/...`; el backend expone `/api/...`. La traducción
existe en las dos capas:

- `frontend/vite.config.ts` — proxy de dev/preview (`npm run dev:lia`):
  `/api/lia-agent/query -> /api/hermes/query` y
  `/api/lia-agent/projects/tasks* -> /api/projects/tasks*`.
- `scripts/lia-production-same-origin-runtime-server.mjs` — runtime productivo
  que sirve `frontend/dist` y traduce los mismos prefijos hacia el backend
  interno en `127.0.0.1:3014`.

## Configuración del proyecto autónomo

El flujo real requiere dos archivos de configuración estrictos (el backend los
valida y falla cerrado ante cualquier campo faltante o extra):

- `config/lia-hermes.projects.example.json` — registro de proyectos
  (`LIA_PROJECT_REGISTRY_PATH`). Debe contener `lia-hermes` activo con su
  `repositoryRoot`.
- `config/lia-hermes.project-verification.example.json` — perfil de
  verificación preautorizada (`LIA_PROJECT_VERIFICATION_PATH`). Ejecuta las
  comprobaciones del repo desde el worktree aislado.

Copiar las plantillas a la configuración de operación (p. ej.
`/opt/lia-os-config/projects.json` y
`/opt/lia-os-config/project-verification.json`) y ajustar `repositoryRoot` a
la ruta real del repositorio. Validez verificable con:

```bash
cd backend/lia-agent && npm run build
cd ../..
node scripts/lia-project-runtime-config-template-self-check.mjs
```

El self-check usa los mismos parsers del backend TypeScript y confirma que una
instrucción real de `lia-hermes` resuelve en la etapa de planificación con las
capacidades aprobadas (`repository_read`, `isolated_worktree_write`,
`run_tests`, `local_commit`).

## Observabilidad segura del flujo autónomo

Los resultados durables de cada tarea (`GET /api/projects/tasks/:taskId` y el
recibo en SQLite) permiten distinguir qué ocurrió sin leer logs internos:

- Recibo terminal exitoso: campo `stages` con las fases completadas en orden
  canónico: `planning`, `hermes` (Hermes Supervisor), `codex`,
  `verification` (verificación técnica), `visualQa` (Visual QA) y `commit`
  (commit local, con el hash en `commit`).
- Falla terminal: el campo `error` incluye `stage` (dónde falló) y
  `completedStages` (qué fases se completaron antes), con el mismo vocabulario.

La traza usa exclusivamente un vocabulario fijo de fase pública; nunca incluye
prompts, comandos, stdout/stderr, rutas privadas, IDs internos de subagentes,
sesiones, credenciales ni secretos. Los registros antiguos sin estos campos
siguen siendo legibles y compatibles.

## Verificación local del flujo

```bash
# Backend (puerto 3014) — requiere registro y perfil de verificación
cd backend/lia-agent
npm run build
LIA_HERMES_EXECUTION_ENABLED=true \
LIA_PROJECT_REGISTRY_PATH=/opt/lia-os-config/projects.json \
LIA_PROJECT_VERIFICATION_PATH=/opt/lia-os-config/project-verification.json \
LIA_PROJECT_TASK_SQLITE_PATH=/opt/lia-os-data/project-tasks.sqlite \
npm run start

# Frontend (http://127.0.0.1:5199)
cd frontend
npm run dev:lia
```

Acceso demo: `ejecutivo@lia.local` / `lia2026`. En **Proyectos**, escribe una
instrucción y ejecútala con LÍA: la UI muestra las etapas (planificación,
Hermes, ejecución, verificación, commit) y el recibo final con verificación y
commit local.

Pruebas:

```bash
node --test scripts/tests/*.test.mjs
cd backend/lia-agent && npm run self-check
cd frontend && npm run build
node scripts/lia-project-runtime-config-template-self-check.mjs
```
