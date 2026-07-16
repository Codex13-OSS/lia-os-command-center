# Evidencia de aprobación — Cierre técnico D7

## Operación aprobada

- Operación: `lia-agent-backend-d7-apply-r5-001`
- Solicitud durable:
  `/var/lib/lia-agent-deploy/requests/lia-agent-backend-d7-apply-r5-001.json`
- SHA-256:
  `e39a53134aa57515dae5bc365954e65cc103680af07093e10b8c49d8376a6dd5`

## Resultados aprobados por la Dirección

- `D7_DRY_RUN_APROBADO`
- `D7_FINAL_APPLY_PREFLIGHT_APROBADO`
- `D7_APPLY_COMPLETADO_Y_VALIDADO`
- `D7_POST_DEPLOY_VALIDACION_READ_ONLY_APROBADA`

## Estado reconocido

La Dirección reconoce como resultado técnico final:

- backend activo `v4.10.0-a`;
- PM2 `lia-agent-backend` único y `online`;
- script `/opt/lia-agent-backend/dist/server.js`;
- cwd `/opt/lia-agent-backend`;
- listener exclusivamente en `127.0.0.1:3014`;
- readiness `transient-success`, intento 2 de 6;
- backup legado íntegro en:
  `/opt/lia-agent-backups/2026-07-16T00-51-53-408Z-lia-agent-backend-d7-apply-r5-001`;
- rollback no ejecutado;
- `pm2 save` ejecutado después del éxito;
- apply ejecutado exactamente una vez;
- solicitud durable sin cambios;
- Git y referencias sin cambios;
- failed release histórico D5 preservado;
- ausencia de release preparada y failed release D7.

## Restricciones vigentes

El apply D7 está consumido y no debe repetirse. No se autoriza rollback manual
sin una nueva aprobación explícita.

Continúan desactivadas:

- acciones reales;
- secretos;
- escritura de memoria;
- voz;
- WhatsApp;
- modelos externos;
- conexión funcional con el frontend.

El siguiente paso queda limitado a diseñar una integración controlada
frontend-backend, sin iniciarla mediante este cierre documental.
