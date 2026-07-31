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
- Sin conexion con frontend.
- Sin integraciones externas ejecutables.
- Hermes solo se inspecciona mediante marcadores de archivos; no se importa, inicia ni ejecuta.
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
- `LIA_HERMES_ROOT`: ruta absoluta opcional al checkout de Hermes. Vacía mantiene la integración sin configurar.

No se leen archivos `.env` y no se imprime el entorno completo.

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
