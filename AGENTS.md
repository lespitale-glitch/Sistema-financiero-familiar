# AGENTS.md — Memoria técnica del proyecto

> **Estado:** ✅ **100 % listo para producción** (verificado el 2026-10-27).
>
> - `npm test`: suite completa en verde (correr antes de cada commit).
> - `node scripts/smoke.js`: **SMOKE OK** (9 pasos end-to-end).
> - `node scripts/check.js`: sintaxis ESM y estructura de despliegue completas.
>
> La aplicación corre de forma autónoma con Docker Compose, Render o systemd, **sin depender de OpenCode**.

---

## 1. Resumen

Sistema financiero familiar con:

- Bot de Telegram (Telegraf) para registrar gastos, ingresos e inversiones por texto, voz, foto o PDF.
- OCR de facturas con Gemini y confirmación por botones.
- Ingesta de facturas por email (HTTP push o IMAP).
- Presupuestos dinámicos por categoría y presupuesto general.
- Alertas por umbral (80 % / 100 %), sin duplicados.
- Resúmenes automáticos diario, semanal y cierre mensual.
- Metas de ahorro/inversión.
- API HTTP protegida por token.
- Persistencia SQLite (`node:sqlite`) o Supabase (PostgREST).

Stack: **Node.js ESM**, Express, Telegraf, `dotenv`, `node:sqlite`, Gemini REST. Sin build step. Node **≥ 22.13** (Docker y Render usan Node 24).

---

## 2. Invariantes y decisiones

1. **Dinero en centavos enteros.** Toda la persistencia usa `amount_cents`, `budget_cents`, `target_cents`. La conversión desde unidades ocurre en los bordes (`toCents`) y el formateo en `formatCents`.
2. **Fechas ISO UTC.** La zona horaria solo se usa para calcular períodos y mostrar fechas (`TZ`, `REPORT_TIMEZONE`).
3. **La app arranca sin servicios opcionales.** Si falta token de Telegram, Gemini o IMAP, solo se deshabilita esa función; se emiten warnings de configuración.
4. **Errores de configuración bloqueantes:** token de Telegram con formato inválido, webhook sin `PUBLIC_URL`/HTTPS o sin `TELEGRAM_WEBHOOK_SECRET`, Supabase sin URL o key, Telegram IDs duplicados.
5. **Identidad estricta si `FAMILY_MEMBERS` está configurado.** Un usuario desconocido recibe su Telegram ID y no puede operar. Si la lista está vacía, el modo es abierto y auto-registra.
6. **Categorías:** resolución por `categoryId`, nombre, o fallback por tipo (`Otros`, `Otros ingresos`, `Inversiones`).
7. **Alertas deduplicadas** por categoría + umbral + período mediante `repos.alerts.claim`.
8. **Scheduler idempotente:** tick cada 30 s, máximo una ejecución por día local, marcas en `settings` (`scheduler.lastRun.<job>`).
9. **Un solo poller de Telegram por token.** Dos instancias en `polling` producen `409 Conflict`; para escalar, usar `webhook`.
10. **Logs JSON** por línea, con redacción de tokens, secretos, passwords y claves API.

---

## 3. Mapa de módulos

| Archivo | Responsabilidad |
|---|---|
| `src/index.js` | Entrypoint. Crea la app, arranca, escucha `SIGINT`/`SIGTERM` y apaga limpio. |
| `src/app.js` | Ensambla config, logger, DB, servicios, bot, web y scheduler. Expone `start()`/`stop()`. |
| `src/config.js` | Carga `.env`, parsea `FAMILY_MEMBERS`, valida y congela la configuración. Resuelve `SQLITE_PATH` relativo contra la raíz. |
| `src/logger.js` | Logger estructurado sin dependencias. |
| `src/domain.js` | Tipos de movimiento, roles, fuentes, estados, categorías default y keywords. |
| `src/db/index.js` | Selecciona SQLite o Supabase y crea repositorios. |
| `src/db/sqlite-store.js` | Store SQLite con WAL, foreign keys y `busy_timeout`. |
| `src/db/supabase-store.js` | Store PostgREST. Requiere `supabase/schema.sql` aplicado manualmente. |
| `src/db/repositories.js` | Repositorios de users, categories, transactions, documents, goals, alerts, settings y email log. |
| `src/services/transactions.js` | Caso de uso central: valida, resuelve categoría, persiste y evalúa alertas. |
| `src/services/budgets.js` | Cálculo de estado de presupuesto y evaluación de umbrales. |
| `src/services/alerts.js` | Resumen mensual, evaluación, deduplicación y notificación. |
| `src/services/reports.js` | Renderizado HTML de balance, presupuesto, gastos, inversiones, resúmenes y facturas. |
| `src/services/parser.js` | Parser de lenguaje natural: montos, fechas, tipo, categoría, hashtags. |
| `src/services/gemini.js` | Cliente REST de Gemini (texto, visión, audio). |
| `src/services/ocr.js` | Extracción de facturas y transcripción de audio. |
| `src/services/email.js` | Ingesta HTTP/IMAP, deduplicación y OCR de adjuntos. |
| `src/services/scheduler.js` | Resúmenes diario/semanal/mensual. |
| `src/services/users.js` | Resolución de identidad Telegram/email. |
| `src/services/notifier.js` | Envío de mensajes a Telegram; se conecta al bot al arrancar. |
| `src/bot/index.js` | Telegraf, middleware de auth, registro de handlers y publicación de comandos. |
| `src/bot/commands.js` | Definición y registro de los 22 comandos. |
| `src/bot/handlers.js` | Handlers de comandos, texto, voz, documentos y callbacks. |
| `src/bot/keyboards.js` | Teclados inline (confirmar/editar/descartar). |
| `src/web/server.js` | Express: health, API, webhook de Telegram e ingesta de email. |
| `src/utils/*` | Dinero, fechas, HTML de Telegram. |

### Secuencia de arranque (`createApp`)

1. Carga `.env` y valida la configuración.
2. Crea e inicializa el store; siembra categorías default si faltan.
3. Sincroniza `FAMILY_MEMBERS` a `users`.
4. Crea notifier, cliente Gemini, OCR, alerts, transactions y users.
5. Crea email (usa `services.*` en runtime) y scheduler.
6. Crea el bot si hay token; conecta el notifier.
7. Crea el servidor web.
8. `start()`: registra webhook (si aplica), lanza polling (si aplica), arranca scheduler, poller IMAP y servidor HTTP.

`stop()` es idempotente y tolerante a fallos: scheduler → IMAP → bot → web → DB.

---

## 4. Flujos principales

### Texto libre

`handleText` → `parser.parseTransactionMessage` → `services.transactions.create` → persistencia → `alerts.evaluateForTransaction` → confirmación HTML.

- Los hashtags se enmascaran para que las keywords del texto tengan prioridad; los hashtags son respaldo.
- En empate de categorías gana la que aparece más tarde en el texto (contexto del comercio).
- Montos negativos o inválidos se rechazan.

### Factura (foto/PDF)

`handleDocument` → descarga de Telegram → `services.ocr.extractDocument` → `documents.create` con estado pendiente → vista previa con teclado → callback:

- **Confirmar** → `transactions.confirmDocument` → movimiento confirmado + alertas.
- **Editar** → espera `/corregir <monto>`.
- **Descartar** → documento descartado.

### Voz

`handleVoice` → descarga → `ocr.transcribeAudio` → mismo parser que texto. Si no hay monto, se pide aclaración.

### Email

`POST /api/email/inbound` → validación de token → `services.email.ingestEmail`:

- Remitente desconocido → `403` y registro en `email_log`.
- Duplicado por `messageId` → no se procesa.
- Adjunto soportado → OCR → documento pendiente + notificación.
- Solo texto → parser directo.
- Sin monto → `422` y estado `unparsed`.

El poller IMAP reutiliza el mismo `ingestEmail` y marca los mensajes como leídos.

### Alertas

Al confirmar un gasto, `alerts.evaluateForTransaction` calcula el resumen del mes:

- Dispara umbrales configurados (`80,100` por defecto) para la categoría afectada.
- Dispara el umbral del presupuesto general si existe.
- Deduplica con `alerts.claim`.
- Envía al `FAMILY_CHAT_ID` y, si `ALERT_AUTHOR_DM=true`, también al autor.

### Scheduler

Cada 30 s verifica la hora local:

- Diario: resumen del día + evaluación de alertas del mes.
- Semanal: rango lunes-domingo.
- Mensual: el día 1 cierra el mes anterior.

Nunca rellena días perdidos ni duplica envíos tras un reinicio.

---

## 5. Variables de entorno (documentación completa)

Se leen de `.env` o del entorno. `.env.example` es la plantilla oficial.

### General

| Variable | Requerida | Default | Descripción |
|---|---|---|---|
| `NODE_ENV` | No | `development` | `production` en despliegues. |
| `PORT` | No | `3000` | Puerto HTTP. Render lo inyecta automáticamente. |
| `TZ` | No | `UTC` | Zona horaria IANA. |
| `LOG_LEVEL` | No | `info` | `debug`, `info`, `warn`, `error`, `silent`. |
| `APP_NAME` | No | `Finanzas Familiares` | Nombre visible. |
| `CURRENCY` | No | `ARS` | ISO 4217. |
| `LOCALE` | No | `es-AR` | Formato regional. |
| `FAMILY_CHAT_ID` | Recomendada | vacío | Chat/grupo de alertas y resúmenes. |
| `API_TOKEN` | Sí para API | vacío | Bearer token de `/api/*`. Sin él, API `503`. |

### Telegram

| Variable | Requerida | Default | Descripción |
|---|---|---|---|
| `TELEGRAM_BOT_TOKEN` | Sí para bot | vacío | Token de @BotFather. Sin él, bot deshabilitado. |
| `TELEGRAM_MODE` | No | `polling` | `polling` o `webhook`. |
| `PUBLIC_URL` | Solo webhook | vacío | URL HTTPS sin barra final. |
| `TELEGRAM_WEBHOOK_SECRET` | Sí en webhook | vacío | Secreto del header `X-Telegram-Bot-Api-Secret-Token`. Error bloqueante si falta en webhook. |
| `TELEGRAM_ALLOWED_CHAT_IDS` | No | vacío | IDs extra autorizados, separados por coma. |

### Familia

| Variable | Requerida | Default | Descripción |
|---|---|---|---|
| `FAMILY_MEMBERS` | Recomendada | vacío | `Nombre\|rol\|telegram_id\|email` separado por `;` o saltos de línea. |

Roles: `husband`, `wife`, `daughter`, `son`, `other`.

### Base de datos

| Variable | Requerida | Default | Descripción |
|---|---|---|---|
| `DB_DRIVER` | No | `sqlite` | `sqlite` o `supabase`. |
| `SQLITE_PATH` | No | `./data/finanzas.sqlite` | Ruta del archivo. En Docker/Render: `/app/data/finanzas.sqlite`. |
| `SUPABASE_URL` | Solo Supabase | vacío | URL del proyecto. |
| `SUPABASE_SERVICE_ROLE_KEY` | Solo Supabase | vacío | Service role key (solo backend). |
| `SUPABASE_SCHEMA` | No | `public` | Esquema Postgres. |

### Gemini

| Variable | Requerida | Default | Descripción |
|---|---|---|---|
| `GEMINI_API_KEY` | Sí para OCR/voz | vacío | API key de Google AI Studio. |
| `GEMINI_MODEL` | No | `gemini-2.5-flash` | Modelo de texto. |
| `GEMINI_VISION_MODEL` | No | = `GEMINI_MODEL` | Modelo de visión. |
| `GEMINI_AUDIO_MODEL` | No | = `GEMINI_MODEL` | Modelo de audio. |
| `GEMINI_BASE_URL` | No | `https://generativelanguage.googleapis.com/v1beta` | Endpoint. |
| `MAX_UPLOAD_BYTES` | No | `10485760` | Límite de archivo (1 KB–40 MB). |

### Presupuestos, alertas y resúmenes

| Variable | Requerida | Default | Descripción |
|---|---|---|---|
| `BUDGET_ALERT_THRESHOLDS` | No | `80,100` | Umbrales de alerta. |
| `ALERTS_ENABLED` | No | `true` | Activa alertas. |
| `DAILY_SUMMARY_AT` | No | `21:00` | Hora local del resumen diario. |
| `WEEKLY_SUMMARY_DAY` | No | `1` | `0` domingo … `6` sábado. |
| `WEEKLY_SUMMARY_AT` | No | `09:00` | Hora local del resumen semanal. |
| `MONTHLY_SUMMARY_AT` | No | `08:00` | Hora local del cierre mensual. |
| `ALERT_AUTHOR_DM` | No | `true` | Alerta también al autor. |
| `REPORT_TIMEZONE` | No | = `TZ` | Zona horaria de períodos. |

### Email

| Variable | Requerida | Default | Descripción |
|---|---|---|---|
| `EMAIL_INGEST_TOKEN` | Sí para ingesta HTTP | = `API_TOKEN` | Token de `POST /api/email/inbound`. |
| `IMAP_HOST` | No | vacío | Activa el poller junto con usuario/password. |
| `IMAP_PORT` | No | `993` | Puerto. |
| `IMAP_SECURE` | No | `true` | TLS. |
| `IMAP_USER` | No | vacío | Usuario. |
| `IMAP_PASSWORD` | No | vacío | Password / app password. |
| `IMAP_MAILBOX` | No | `INBOX` | Buzón. |
| `IMAP_POLL_SECONDS` | No | `300` | Intervalo (mín. 30 s). |
| `EMAIL_FORWARD_ADDRESS` | No | vacío | Dirección informativa. |

### API

| Variable | Requerida | Default | Descripción |
|---|---|---|---|
| `INGEST_RATE_LIMIT_PER_MINUTE` | No | `30` | Límite por IP/minuto. `0` lo desactiva. |
| `TRUST_PROXY` | No | `1` | Valor de Express `trust proxy` (saltos, `true`/`false` o lista de IPs). Nunca `true` en producción. |

---

## 6. Contrato de despliegue

### `Dockerfile`

- Base `node:24-alpine` (incluye `node:sqlite`).
- `npm install --omit=dev --ignore-scripts` solo con `package.json`/lock (capa cacheada).
- Copia `src/` y `scripts/`.
- Usuario sin privilegios `app` (uid **1001**), dueño de `/app` y `/app/data`.
- `VOLUME ["/app/data"]` y `EXPOSE 3000`.
- Healthcheck con `fetch('http://127.0.0.1:PORT/healthz')`.
- `CMD ["node", "src/index.js"]`.

### `docker-compose.yml`

- `build: .`, `container_name: finanzas-app`, `restart: unless-stopped`.
- `env_file: .env` (obligatorio; crear desde `.env.example`).
- Sobrescribe `NODE_ENV=production`, `SQLITE_PATH=/app/data/finanzas.sqlite`, `PORT`.
- Volumen nombrado `finanzas-data` → `/app/data`.
- Healthcheck idéntico al Dockerfile.

### `render.yaml`

- Blueprint con `services:` (lista), `type: web`, `runtime: node`.
- `plan: starter`, `numInstances: 1`, `autoDeploy: true`.
- `buildCommand: npm install --omit=dev`, `startCommand: npm start`.
- `healthCheckPath: /healthz`.
- Disco `finanzas-data` de 1 GB en `/app/data`.
- Variables base + secretos con `sync: false` (`TELEGRAM_BOT_TOKEN`, `FAMILY_MEMBERS`, `FAMILY_CHAT_ID`, `GEMINI_API_KEY`) y generadas (`API_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `EMAIL_INGEST_TOKEN`).
- `TELEGRAM_MODE=polling` por defecto; para webhook agregar `PUBLIC_URL` y cambiar el modo.

### `deploy/systemd/finanzas.service`

- `WorkingDirectory=/opt/finanzas`, `EnvironmentFile=/opt/finanzas/.env`.
- `ExecStart=/usr/bin/node src/index.js`.
- `Restart=on-failure`, `RestartSec=5`.
- `User=finanzas`, `NoNewPrivileges`, `ProtectHome`, `ProtectSystem=strict`.
- `ReadWritePaths=/opt/finanzas/data`.
- `KillSignal=SIGTERM`, `TimeoutStopSec=20`.

### `.dockerignore`

Excluye `node_modules`, `.env`, datos SQLite, tests, `.git` y documentación. Reduce el contexto y evita filtrar secretos.

---

## 7. API y comandos

### API

| Método | Ruta | Auth | Descripción |
|---|---|---|---|
| GET | `/` | No | Metadatos. |
| GET | `/healthz`, `/readyz` | No | Ping a la base. |
| POST | `/api/telegram/webhook` | Secreto | Update de Telegram. |
| POST | `/api/email/inbound` | Ingest token | Email entrante. |
| GET | `/api/summary` | Bearer | Totales + presupuesto. |
| GET/POST | `/api/transactions` | Bearer | Listar/crear movimientos. |
| GET | `/api/alerts` | Bearer | Alertas del mes. |
| GET/POST | `/api/categories` | Bearer | Listar/crear categorías. |
| GET/POST | `/api/goals` | Bearer | Listar/crear metas. |
| POST | `/api/goals/:id/contribute` | Bearer | Aportar a meta. |

La comparación de tokens usa SHA-256 + `timingSafeEqual`. La ingesta tiene rate limit en memoria por IP.

### Comandos del bot

`/start`, `/ayuda`, `/balance`, `/presupuesto`, `/gastos`, `/ingresos`, `/inversiones`, `/gasto`, `/ingreso`, `/inversion`, `/movimientos`, `/categorias`, `/nueva_categoria`, `/presupuesto_set`, `/metas`, `/meta`, `/aportar`, `/corregir`, `/reporte`, `/exportar`, `/alertas`, `/id`.

Además: texto libre, voz, fotos, PDF y callbacks de confirmación.

---

## 8. Modelo de datos

| Tabla | Campos relevantes |
|---|---|
| `users` | `id`, `name`, `role`, `telegram_id`, `email`, `active`. |
| `categories` | `id`, `name`, `type`, `emoji`, `keywords`, `monthly_budget_cents`, `active`. |
| `transactions` | `id`, `user_id`, `category_id`, `type`, `amount_cents`, `currency`, `note`, `source`, `status`, `occurred_at`, `metadata`, `document_id`. |
| `documents` | Datos de OCR, estado (`pending`, `confirmed`, `discarded`), vínculo a transacción. |
| `goals` | `id`, `name`, `target_cents`, `contributed_cents`, `deadline`, `user_id`. |
| `alerts` | Clave de deduplicación, categoría, umbral, período, payload. |
| `settings` | `budget.overall_cents`, `scheduler.lastRun.*`, preferencias. |
| `email_log` | `message_id`, remitente, estado, error y deduplicación. |

Categorías default (presupuesto en unidades): Supermercado 350.000, Comida 120.000, Transporte 100.000, Servicios 90.000, Alquiler 500.000, Salud 80.000, Educación 150.000, Entretenimiento 70.000, Hogar 60.000. Ingresos e inversiones no tienen presupuesto.

---

## 9. Pruebas

Comandos:

```bash
npm test          # node --test "tests/*.test.js"
npm run smoke     # scripts/smoke.js
npm run check     # scripts/check.js
```

En Windows/PowerShell usar `cmd /c "npm.cmd test"` si la execution policy bloquea `npm.ps1`.

Cobertura funcional actual:

- Configuración y parseo de familia.
- Dominio y utilidades (dinero, fechas, HTML).
- Parser de lenguaje natural (21 pruebas).
- Presupuestos y alertas (15 pruebas).
- Repositorios SQLite.
- Servicio de transacciones y alertas.
- OCR/Gemini (17 pruebas).
- Email (9 pruebas).
- Scheduler (7 pruebas).
- Handlers del bot (24 pruebas).
- Web/API (12 pruebas).
- Reportes y smoke.

Resultado esperado: **0 fail**; smoke **9/9 pasos**.

### Notas de entorno de pruebas

- Fechas fijas: `2026-10-15T12:00:00.000Z`, mes `2026-10`.
- Fixtures financieros: `NOW=2026-10-24T15:00:00.000Z`, TZ `America/Argentina/Buenos_Aires`, moneda `ARS`.
- Harness del bot: `tests/helpers/bot-harness.js` (`createHarness`, `createFakeCtx`, `TEST_ENV`).
- No se llaman servicios externos: Gemini, Telegram e IMAP se simulan.

---

## 10. Operación

### Arranque local

```bash
cp .env.example .env
npm install
npm start
curl http://localhost:3000/healthz
```

### Docker Compose

```bash
cp .env.example .env
# editar .env
docker compose up -d --build
docker compose ps
docker compose logs -f app
```

### Render

Importar el repositorio como Blueprint; completar secretos `sync: false`. Requiere plan Starter por el disco persistente. Una sola instancia en polling.

### systemd

```bash
sudo cp deploy/systemd/finanzas.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now finanzas
journalctl -u finanzas -f
```

### Salud y respaldos

- Salud: `GET /healthz` (200 con `db: ok`; 503 si falla la base).
- SQLite: detener el proceso y copiar `finanzas.sqlite` (+ `-wal`/`-shm`) o usar `sqlite3 .backup`.
- Docker: volumen `finanzas-data`; Render: disco `/app/data`; systemd: `/opt/finanzas/data`.
- Antes de actualizar: backup + `git pull` + rebuild/restart.

---

## 11. Seguridad

- `.env` fuera de git (`.gitignore` y `.dockerignore`).
- `API_TOKEN` de 32 bytes; comparación en tiempo constante.
- `SUPABASE_SERVICE_ROLE_KEY` solo backend.
- Webhook con secreto obligatorio y HTTPS.
- `trust proxy` acotado (`TRUST_PROXY`, default 1 salto): la IP del rate limit no se puede falsear.
- Body JSON 1 MB global; 25 MB solo en ingesta de email, después de validar el token.
- `FAMILY_MEMBERS` obligatorio en producción.
- Rate limit de ingesta.
- Redacción de secretos en logs.
- Contenedor non-root (uid 1001) y systemd hardened.

---

## 12. Limitaciones conocidas

- El rate limit de ingesta es **en memoria**; con varias réplicas no es global.
- El parser es heurístico para español rioplatense; casos muy ambiguos pueden requerir `/corregir` o un comando explícito.
- Gemini puede fallar por cuota/red; en ese caso OCR/voz se degradan, pero el texto libre sigue funcionando.
- SQLite no soporta escritura concurrente multi-proceso; usar una sola instancia o Supabase para escalar.
- El modo `polling` no debe ejecutarse en más de una instancia.
- La unidad systemd asume Node en `/usr/bin/node`; ajustar para nvm/volúmenes custom.
- Render Free duerme el servicio: no sirve para un bot permanente.

---

## 13. Checklist de producción

- [x] Suite de pruebas en verde.
- [x] Smoke test end-to-end en verde.
- [x] `node:sqlite` sin dependencias nativas.
- [x] `Dockerfile` multi-stage innecesario (sin build), non-root, healthcheck y volumen.
- [x] `docker-compose.yml` con `restart: unless-stopped`.
- [x] `render.yaml` válido con `services:`, disco persistente y secretos.
- [x] Unidad systemd con hardening y reinicio automático.
- [x] `.dockerignore` y `.gitignore` protegen secretos y datos.
- [x] Documentación completa de variables en `README.md` y `AGENTS.md`.
- [x] `.env.example` completo.
- [x] API con token, rate limit y healthchecks.
- [x] Alertas deduplicadas y scheduler idempotente.
- [x] Logs JSON con redacción de secretos.

**Conclusión:** la aplicación está **100 % lista para producción** y puede operar de forma permanente e independiente mediante Docker Compose, Render o systemd.
