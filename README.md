# zityhub-bot

Reserva automáticamente un puesto en Zityhub en cuanto se abre el día nuevo de la
ventana de reserva. Corre en GitHub Actions (`.github/workflows/reserva.yml`).

## Cómo usarlo

1. Haz un fork de este repo. Los secrets y las variables no se copian con el fork:
   cada uno pone los suyos.
2. En tu fork, pestaña **Actions**: pulsa *I understand my workflows, go ahead and
   enable them*. GitHub desactiva Actions en los forks hasta que lo activas.
3. Pestaña **Settings** > menú izquierdo, sección *Security* > **Secrets and
   variables > Actions** (o directo:
   `https://github.com/<tu-usuario>/zityhub-bot/settings/variables/actions`).
   Tiene dos pestañas, *Secrets* y *Variables*. En cada una: *New repository
   secret* / *New repository variable*, nombre exacto y valor.
4. Rellena los secrets y las variables de abajo.
5. Prueba en **Actions > Reserva Zityhub > Run workflow** con modo `simulacion`:
   el log dice qué puesto reservaría sin reservar nada. En `fecha` puedes poner un
   día concreto (`2026-10-24`, aunque sea fin de semana); vacío = el día que toca.

Las tiradas programadas reservan de verdad.

### Secrets (pestaña *Secrets*)

| Nombre | Qué es |
|---|---|
| `ZITYHUB_EMAIL` + `ZITYHUB_PASSWORD` | Tu login de Zityhub. Recomendado. |
| `ZITYHUB_COOKIE` | Alternativa al login: la cabecera `Cookie` de una sesión abierta. Caduca. |

### Variables (pestaña *Variables*)

| Nombre | Obligatoria | Por defecto | Qué es |
|---|---|---|---|
| `ZH_PERSON_ID` | sí | | Tu id de persona en Zityhub. |
| `ZH_SPACE_ID` | sí | | Id del espacio (planta/zona) donde reservar. |
| `ZH_DESK_IDS` | sí* | | Ids de puestos por preferencia, separados por comas: `32256,32286`. |
| `ZH_FALLBACK` | no | `fail` | `any` = si tus puestos están ocupados, coge cualquiera libre. *Con `any`, `ZH_DESK_IDS` es opcional. |
| `ZH_START` | no | `09:00` | Hora de inicio (múltiplo de 30 min). |
| `ZH_END` | no | `18:00` | Hora de fin. |
| `ZH_TZ` | no | `Europe/Madrid` | Zona horaria de las horas y de la medianoche. |
| `ZH_ADVANCE_DAYS` | no | `5` | Días laborables de antelación de la ventana de reserva. |
| `ZH_HOLIDAYS` | no | | Festivos sin reserva: `2026-12-08,2026-12-25`. |

### Cómo sacar los ids

Entra en la web de Zityhub con las herramientas de desarrollador abiertas
(pestaña *Network*) y filtra por `api.zityhub.com`:

- `ZH_PERSON_ID`: el número de la petición `/api/v1/person/<id>`.
- `ZH_SPACE_ID`: abre el plano de tu planta; es el número de
  `/api/v1/resources/<id>/availability`.
- `ZH_DESK_IDS`: en la respuesta de esa misma petición, cada puesto de `children`
  tiene `resourceName` (p. ej. `Desk 132`) y su `resourceId`, que es el id que va aquí.

### Horario

El cron arranca a las 23:47 de Madrid (domingo a jueves) y el script espera a la
medianoche. Si usas otra zona horaria, ajusta los `cron` del workflow: GitHub no
deja meter variables ahí.
