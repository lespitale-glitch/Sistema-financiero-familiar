# CLAUDE.md — Finanzas Familiares

Guía corta para asistentes de IA. La memoria técnica completa está en [`AGENTS.md`](AGENTS.md); la documentación de usuario, en [`README.md`](README.md).

## Qué es

Bot de Telegram + API HTTP para las finanzas de la familia: gastos, ingresos e inversiones por texto, voz, foto o PDF (OCR con Gemini o con el motor local de macOS), vencimientos con recordatorio, gastos en dólares convertidos a pesos, presupuestos con alertas, resúmenes automáticos, metas e ingesta de facturas por email.

## Stack

- **Node.js ≥ 22.13, ESM** (`"type": "module"`), sin build step ni TypeScript.
- Express 4 (API), Telegraf 4 (bot), `dotenv`.
- Persistencia: `node:sqlite` (default) o Supabase vía PostgREST (`fetch`).
- OCR/voz: Gemini por REST (sin SDK) o, con `AI_PROVIDER=local`, Vision de macOS (`bin/macos/finanzas-ocr.swift`) + whisper.cpp + ffmpeg.
- Cotización del dólar: `USD_ARS_RATE` fija o dolarapi.com.
- Opcionales: `imapflow` + `mailparser` para IMAP.

## Comandos

```bash
npm install          # dependencias
npm run dev          # desarrollo con --watch
npm start            # producción
npm test             # node --test "tests/*.test.js"
npm run check        # sintaxis ESM + archivos de despliegue
npm run smoke        # arranque real + endpoints (SQLite en memoria)
npm run seed         # categorías y miembros iniciales
npm run setup:mac    # (solo Mac) compila el OCR, instala whisper-cpp/ffmpeg y baja el modelo
```

## Estructura

```text
src/
  index.js        entrypoint + apagado limpio (SIGINT/SIGTERM)
  app.js          ensambla config → logger → DB → servicios → bot → web → scheduler
  config.js       carga .env, valida (validateConfig) y congela la config
  domain.js       tipos, roles, estados, categorías default
  logger.js       logs JSON con redacción de secretos
  bot/            Telegraf: index (auth), commands, handlers, keyboards
  db/             index (selector), sqlite-store, supabase-store, repositories, rows, schema.sql
  services/       transactions, budgets, alerts, reports, parser, gemini, ocr, email, scheduler, users, notifier,
                  bills (vencimientos), fx (dolar), local-engine (Vision/whisper), invoice-text (reglas de facturas),
                  bank-alerts (avisos del Banco Macro por email)
  utils/          money (centavos), dates (zonas horarias), telegram-html
  web/server.js   Express: /healthz, /readyz, /api/*, webhook de Telegram, ingesta de email
bin/macos/        finanzas-ocr.swift (el binario compilado y models/ no se suben)
tests/            node:test; helpers en tests/helpers/
scripts/          check, seed, smoke, setup-mac.sh, mac-servicio.sh (LaunchAgent)
deploy/systemd/   unidad systemd
supabase/         schema.sql para Supabase
```

## Reglas del proyecto

1. **Dinero en centavos enteros** (`amount_cents`, etc.). Convertir solo en los bordes con `toCents` / `formatCents` (`src/utils/money.js`).
2. **Fechas en ISO UTC**; la zona horaria solo para períodos y presentación (`src/utils/dates.js`).
3. **La app arranca sin servicios opcionales**: si falta Telegram, Gemini o IMAP, se deshabilita esa función con un warning. Solo son bloqueantes los errores de `validateConfig`.
4. **SQL siempre parametrizado** (`?`). Nombres de tabla/columna solo desde el código, nunca desde input.
5. **Tokens comparados con `safeEqual`** (`crypto.timingSafeEqual`) en `src/web/server.js`.
6. **Seguridad HTTP**: `trust proxy` sale de `TRUST_PROXY` (default `1`, nunca `true`); JSON 1 MB global, 25 MB solo en `/api/email/inbound` tras validar token; webhook exige `TELEGRAM_WEBHOOK_SECRET`.
7. **Logs**: usar el logger inyectado (`logger.info/warn/error(msg, ctx)`), nunca `console.log` en `src/`. Incluir contexto útil (`requestId`, ids) para depurar.
8. **Mensajes al usuario en español** (rioplatense), errores de API como `{ error: 'kebab-case', message }`.
9. **Un solo poller de Telegram por token**; para escalar, webhook.
10. **Inyección de dependencias**: los servicios reciben `{ config, repos, logger, clock, ... }`; los tests usan fakes de `tests/helpers/`.
11. **Nunca registrar dólares como pesos**: todo monto en otra moneda pasa por `fx` en `transactions.create`; sin cotización se lanza `FX_UNAVAILABLE`.
12. **El motor local no puede romper la app**: si falta un binario, se deshabilita OCR o voz y se loguea el motivo (`local.problems`).
13. **La Mac es compartida (Canal7 + servidor de medios)**: antes de cambiar algo en la Mac, leer `~/Mac-reglas/REGLAS_MAC.md`. La voz local solo transcribe si nadie más usa Whisper (`pgrep`, solo lectura); nunca `pkill`/`kill` por patrón, ni `brew install` sin `--dry-run`.
14. **Tests sin datos reales**: los ejemplos de facturas, avisos y comprobantes en `tests/` usan nombres, CVU, CUIT, teléfonos y tarjetas inventados, nunca los de los comprobantes reales de la familia.

## Antes de commitear

- `npm test` y `npm run check` en verde; agregar tests para cada fix o feature.
- **Nunca** commitear `.env`, `data/`, `*.sqlite*` ni `node_modules/` (ya están en `.gitignore`).
- Si se agrega una variable de entorno: actualizar `src/config.js`, `.env.example`, `README.md` (tabla de variables) y `AGENTS.md`.
- Commits descriptivos en español o inglés, estilo `tipo: resumen` (`fix:`, `feat:`, `docs:`, `chore:`).
