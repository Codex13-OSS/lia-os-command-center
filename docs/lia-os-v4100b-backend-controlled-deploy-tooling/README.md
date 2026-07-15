# v4.10.0-B Controlled Backend Deploy Tooling

## Estado

La subfase v4.10.0-A dejo implementado el backend TypeScript/Express en `backend/lia-agent`: compila, sus pruebas pasan y el `self-check` local quedo aprobado. Ese backend todavia no fue desplegado.

El runtime vivo sigue siendo el backend legado en `/opt/lia-agent-backend`, administrado por PM2 como `lia-agent-backend`, ejecutando `server.mjs` en `127.0.0.1:3014`.

## Arquitectura

Se agrego `scripts/lia-agent-backend/deploy-controller.mjs`, un controlador Node.js sin dependencias npm externas. El request JSON declara la version esperada del repositorio, el runtime actual, el objetivo, rutas permitidas, proceso PM2, host, puerto, endpoints y puertos protegidos.

Modos:

- `--dry-run`: valida y planea sin escribir.
- `--apply`: repite validaciones, ejecuta `npm run self-check`, prepara el release bajo la raiz de backups, instala dependencias productivas, valida manifests, valida ausencia de symlinks, calcula hashes, valida mismo filesystem, inspecciona PM2 con `pm2 jlist`, detiene solo `lia-agent-backend` si esta presente, mueve el live a backup con `rename`, mueve el release a live con `rename`, arranca el objetivo sin ejecutar delete interno, valida PM2/health/status/404/405/loopback/3004/3023 y ejecuta `pm2 save` solo al final.
- `--rollback`: valida un backup dentro de `/opt/lia-agent-backups`, rechaza symlinks y estados ambiguos, inspecciona PM2 con `pm2 jlist`, detiene `lia-agent-backend` solo si esta presente, restaura con `rename(backupDir, deployDir)`, arranca el script original esperado sin delete interno y valida antes de `pm2 save`.

PM2 se controla con argumentos separados y `shell: false`. La inspeccion usa exclusivamente `pm2 jlist`; no hay grep, jq, shell, ids arbitrarios, `pm2 delete all` ni `pm2 kill`. Si `pm2 jlist` devuelve JSON invalido o dos entradas con nombre `lia-agent-backend`, el controlador falla cerrado. Los procesos con otro nombre se ignoran y no se operan.

La detencion es idempotente: si `lia-agent-backend` esta ausente, no se ejecuta `pm2 delete`; si esta presente, se ejecuta exactamente una vez `pm2 delete lia-agent-backend` y se vuelve a consultar `pm2 jlist` para confirmar ausencia. El arranque esta separado: `pm2 start <script> --name lia-agent-backend --interpreter node` corre con cwd igual a `deployDir`, host `127.0.0.1` y puerto `3014`; luego se valida que el proceso este online, con script esperado y cwd esperado cuando PM2 lo expone.

El deploy vivo no se borra recursivamente. El backup es el runtime original obtenido mediante rename atomico del directorio vivo. El release se prepara completamente antes del corte y el intercambio se rechaza si `deployDir`, `backupRoot` y el release preparado no estan en el mismo filesystem.

El rollback automatico queda disenado para activarse si `--apply` falla despues de mover el backend vivo al backup. Antes de mover un release fallido, reconsulta PM2 y detiene `lia-agent-backend` solo cuando existe. Esto cubre estados parciales: segundo rename fallido con proceso ausente, start fallido antes de registrar proceso, proceso registrado en estado errored, proceso online con health fallido y proceso ya ausente. Si el release objetivo ya quedo en `deployDir`, se mueve a un directorio `failed-release-<operationId>` dentro de `backupRoot` como evidencia y luego se restaura el backup original por rename. Los releases fallidos se conservan; no se borran automaticamente.

## Rutas Permitidas

- Repositorio: `/opt/executive-platform-demo`
- Source backend: `/opt/executive-platform-demo/backend/lia-agent`
- Deploy vivo: `/opt/lia-agent-backend`
- Backups: `/opt/lia-agent-backups`
- Proceso PM2: `lia-agent-backend`
- Host: `127.0.0.1`
- Puerto backend: `3014`
- Puertos protegidos: `3004`, `3014`, `3023`

## Evidencias

El controlador produce JSON determinista por stdout. Los errores operativos van a stderr. El plan de dry-run lista operaciones en orden estable, release preparado previsto, raiz de backups, validacion de mismo filesystem, destinos ausentes, renames atomicos, rollback por rename y `pm2 save` posterior a validacion.

## Pruebas

Comandos autorizados:

```bash
node --check scripts/lia-agent-backend/deploy-controller.mjs
node --test scripts/lia-agent-backend/tests/deploy-controller.test.mjs
git diff --check
```

Las pruebas usan fixtures temporales y runner falso. El runner falso modela PM2 con `present`, `status`, `script`, `cwd` y `version`: `pm2 jlist` devuelve `[]` si el proceso esta ausente, `pm2 delete` falla si se llama dos veces, `pm2 start` falla si el nombre ya existe y `pm2 save` no cambia estado. No usan PM2 real, puertos reales, red externa, Nginx, systemctl, GitHub ni secretos.

## Exclusiones

En esta subfase no se ejecuto deploy. No se ejecuto `--apply` real, `--rollback` real ni dry-run real contra el entorno vivo. No se toco PM2 real ni `/opt/lia-agent-backend`. No se creo `/opt/lia-agent-backups`. No se toco Nginx, firewall, frontend, CSS, bases de datos, archivos `.env`, secretos ni GitHub.

## Siguiente Fase Recomendada

v4.10.0-C — Controlled Backend Deploy Dry-Run
