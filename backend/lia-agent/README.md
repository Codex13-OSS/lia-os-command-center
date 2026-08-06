# LIA Agent Backend

Este directorio contiene el backend versionado de LIA O.S. En v4.10.0-A se agrega una base funcional TypeScript/Express sin reemplazar todavia el runtime legado desplegado.

## Runtime legado

`server.mjs` se conserva como runtime legado. Es el formato del backend minimo que ya fue validado y desplegado fuera de este repositorio en `/opt/lia-agent-backend`.

Esta subfase no modifica PM2, no despliega y no copia archivos a `/opt/lia-agent-backend`.

## Backend TypeScript nuevo

El nuevo backend esta en `src/`:

- `src/app.ts`: crea la aplicacion Express sin escuchar puerto.
- `src/server.ts`: carga configuracion y escucha en host/puerto local.
- `src/config.ts`: valida variables permitidas.
- `src/routes/`: rutas `GET /health` y `GET /api/status`.
- `src/middleware/`: 404, 405 y errores JSON.
- `src/contracts/`: contratos tipados de health y status.

## Rutas

- `GET /health`: health compatible con el contrato seguro existente.
- `GET /api/status`: estado interno seguro con capacidades desactivadas.
- `GET /api/hermes/status`: detecta de forma no ejecutable si el runtime Hermes configurado contiene sus archivos esenciales.
- `GET /api/hermes/contracts`: publica los limites de seguridad del adaptador Hermes-LÍA.
- `POST /api/hermes/query`: consulta no interactiva a Hermes; permanece desactivada salvo habilitación explícita.
- `POST /health`: 405 con `Allow: GET`.
- `POST /api/status`: 405 con `Allow: GET`.
- Rutas desconocidas: 404 JSON determinista.

## Limites actuales

- Sin deploy.
- Sin PM2.
- Sin puerto publico.
- Sin acciones reales.
- Sin escritura de memoria.
- Sin voz activa.
- Sin mensajeria real.
- Sin modelos externos.
- Sin claves reales.
- Conexion same-origin con el frontend mediante `/api/lia-agent/*`, traducido por el proxy a `/api/*`.
- Sin integraciones externas ejecutables.
- Hermes se ejecuta con el supervisor V1 solo cuando `LIA_HERMES_EXECUTION_ENABLED=true`; por defecto permanece desactivado.
- Sin acceso directo al `state.db` de Hermes.
- Sin handoff ni multiplexado de perfiles.
- Sin acciones mutables.
- La ejecución de Hermes está desactivada por defecto.
- Cuando se habilita, Hermes baja de privilegios a `hermes-agent` y recibe un entorno mínimo.

## Scripts

```bash
npm run dev
npm run build
npm run start
npm run typecheck
npm test
npm run self-check
npm run health
npm run legacy:start
```

`npm run start` ejecuta solo `dist/server.js`, por lo que requiere `npm run build` previo. `npm run dev` usa `tsx` para desarrollo local del backend TypeScript.
`npm run legacy:start` ejecuta `server.mjs`, el runtime legado conservado durante la transicion.

## Configuracion permitida

- `LIA_AGENT_HOST`: host de escucha. Por defecto `127.0.0.1`; solo se aceptan `127.0.0.1` y `localhost`.
- `LIA_AGENT_PORT`: puerto de escucha. Por defecto `3014`; valores invalidos se rechazan.
- `LIA_AGENT_CORS_ORIGINS`: allowlist separada por comas. Por defecto no habilita CORS externo.
- `LIA_AGENT_LOG_LEVEL`: `silent`, `error`, `warn` o `info`.
- `LIA_AGENDA_SQLITE_PATH`: ruta absoluta opcional a la base SQLite de agenda. Vacía mantiene la lectura de agenda sin configurar.
- `LIA_PROJECT_TASK_SQLITE_PATH`: ruta absoluta opcional a la base SQLite de tareas de proyecto. Vacía mantiene el store en memoria.
- `LIA_PROJECT_REGISTRY_PATH`: ruta absoluta al registro de proyectos autorizados (`{"version":1,"projects":[...]}`). Requerida para el flujo de proyecto autónomo; sin ella toda tarea responde `registry_unavailable`.
- `LIA_PROJECT_VERIFICATION_PATH`: ruta absoluta al perfil de verificación preautorizada. Requerida para tareas con `run_tests` / `local_commit`; sin ella la verificación falla con `verification_unavailable`.
- `LIA_HERMES_ROOT`: ruta absoluta opcional al checkout de Hermes. Vacía mantiene la integración sin configurar.
- `LIA_HERMES_EXECUTION_ENABLED`: habilita o deshabilita la ejecución real de Hermes. Por defecto `false`.
- `LIA_HERMES_PATH`: PATH mínimo con el que se ejecuta Hermes vía `sudo -u hermes-agent -- env -i`.

No se leen archivos `.env` y no se imprime el entorno completo.

## Flujo de proyecto autónomo

El flujo LÍA -> Hermes Supervisor -> Codex -> verificación -> commit local se
expone en `POST /api/projects/tasks` (aceptación async con `taskId`) y
`GET /api/projects/tasks/:taskId` (estado/resultado). La UI de Proyectos usa
`/api/lia-agent/...` y el proxy de Vite traduce esos prefijos al contrato
interno (`/api/projects/tasks`, `/api/hermes/query`).

Ejemplo minimo para ejecutar el flujo de forma local:

```bash
# Backend (puerto 3014)
cd backend/lia-agent
npm run build
LIA_HERMES_EXECUTION_ENABLED=true \
LIA_PROJECT_REGISTRY_PATH=/opt/lia-os-config/projects.json \
LIA_PROJECT_VERIFICATION_PATH=/opt/lia-os-config/project-verification.json \
LIA_PROJECT_TASK_SQLITE_PATH=/opt/lia-os-data/project-tasks.sqlite \
npm run start

# Frontend (otra terminal, http://127.0.0.1:5199)
cd frontend
npm run dev:lia
```

El registro debe contener el proyecto activo (p. ej. `lia-hermes` con
`repositoryRoot` y `enabled: true`) y el perfil de verificación sus
comprobaciones preautorizadas.

## Validacion local TypeScript

Desde este directorio:

```bash
npm run typecheck
npm run build
npm test
npm run self-check
```

Las pruebas levantan la aplicacion en `127.0.0.1` con puerto efimero asignado por el sistema; no usan `3004`, `3014` ni `3023`.

## Nota de seguridad

Este backend no esta listo para exposicion publica. Por defecto escucha en `127.0.0.1`, desactiva `x-powered-by`, limita JSON a `64kb`, no expone stack traces en respuestas y mantiene CORS cerrado salvo allowlist explicita.
