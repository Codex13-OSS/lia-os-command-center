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
```
