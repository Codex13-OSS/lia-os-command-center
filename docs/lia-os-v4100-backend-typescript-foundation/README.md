# v4.10.0-A Backend TypeScript/Express Functional Foundation

## Objetivo

Crear el cimiento funcional del backend real de LIA O.S dentro de `backend/lia-agent`, usando Node.js, Express y TypeScript, sin activar integraciones externas ni desplegar.

## Backend legado encontrado

El repositorio ya contenia un backend minimo en `backend/lia-agent` con:

- `server.mjs`: runtime legado Node HTTP.
- `health.mjs`: contrato `GET /health`.
- `self-check.mjs` y `local-health-check.mjs`: validaciones locales.

La copia viva indicada en `/opt/lia-agent-backend` no fue modificada. El proceso PM2 `lia-agent-backend` no fue tocado.

## Backend TypeScript nuevo

Se agrego una base TypeScript/Express en `backend/lia-agent/src`:

- Aplicacion separada del proceso que escucha puerto.
- Configuracion validada.
- Health endpoint compatible.
- Status endpoint tipado.
- 404 y 405 deterministas.
- Middleware centralizado de errores.
- CORS por allowlist explicita y desactivado por defecto.
- Pruebas con el test runner nativo de Node.js.

Durante esta transicion, `server.mjs` permanece como runtime legado. El comando nuevo `npm run start` ejecuta solo el backend TypeScript compilado desde `dist/server.js`; no reemplaza el proceso PM2 vivo.

## Rutas implementadas

- `GET /health`: devuelve health seguro y compatible.
- `POST /health`: devuelve 405 JSON con `Allow: GET`.
- `GET /api/status`: devuelve estado seguro con capacidades desactivadas.
- `POST /api/status`: devuelve 405 JSON con `Allow: GET`.
- Rutas desconocidas: devuelven 404 JSON.

## Variables permitidas

- `LIA_AGENT_HOST`: host de escucha; por defecto `127.0.0.1`; solo acepta loopback (`127.0.0.1` o `localhost`).
- `LIA_AGENT_PORT`: puerto; por defecto `3014`; valores invalidos se rechazan.
- `LIA_AGENT_CORS_ORIGINS`: allowlist de origenes CORS separada por comas.
- `LIA_AGENT_LOG_LEVEL`: `silent`, `error`, `warn` o `info`.

No se leen archivos `.env`, no se cargan secretos y no se imprime el entorno completo.

## Capacidades desactivadas

Permanecen desactivadas:

- Escritura de memoria.
- Modelos externos.
- Voz.
- WhatsApp.
- Email.
- Acciones documentales.
- Acciones reales.

## Comandos

Desarrollo:

```bash
npm run dev
```

Build:

```bash
npm run build
```

Pruebas:

```bash
npm test
```

Validacion principal:

```bash
npm run self-check
```

Typecheck:

```bash
npm run typecheck
```

## Comprobaciones de seguridad

- Host por defecto en loopback.
- Puerto por defecto `3014`, sin abrir exposicion publica.
- Pruebas con puerto efimero en `127.0.0.1`.
- `x-powered-by` desactivado.
- JSON limitado a `64kb`.
- CORS ausente por defecto.
- CORS solo mediante allowlist explicita.
- Errores JSON sin stack trace.
- Sin llamadas externas.
- Sin secretos.

## Exclusiones

No hubo despliegue. No se modifico `/opt/lia-agent-backend`. No se modifico PM2, Nginx, firewall, frontend, CSS, puerto `3004`, puerto vivo `3014` ni generador `3023`.

Tampoco se conectaron Claude, Supabase, Whisper, Twilio, SendGrid, Cloudflare R2, generador documental, frontend ni acciones reales.

## Siguiente fase recomendada

Backend Controlled Deploy Alignment.
