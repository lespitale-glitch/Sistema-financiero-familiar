# Finanzas Familiares

Sistema financiero familiar autónomo con **bot de Telegram**, **OCR de facturas con Gemini**, **presupuestos y alertas**, **metas de ahorro/inversión**, **ingesta por email** y una **API HTTP** para integraciones.

> **Estado:** listo para producción. Suite de pruebas con `node --test` y smoke test end-to-end (ver [Pruebas](#pruebas)).

---

## Índice

- [Qué incluye](#qué-incluye)
- [Arquitectura](#arquitectura)
- [Inicio rápido en local](#inicio-rápido-en-local)
- [Crear y conectar el bot de Telegram](#crear-y-conectar-el-bot-de-telegram)
- [Variables de entorno](#variables-de-entorno)
- [Comandos del bot](#comandos-del-bot)
- [API HTTP](#api-http)
- [Facturas, voz y email](#facturas-voz-y-email)
- [Vencimientos](#vencimientos)
- [Dólares](#dólares)
- [Motor local en Mac (sin Gemini)](#motor-local-en-mac-sin-gemini)
- [Presupuestos, alertas y resúmenes](#presupuestos-alertas-y-resúmenes)
- [Base de datos](#base-de-datos)
- [Pruebas](#pruebas)
- [Despliegue permanente](#despliegue-permanente)
  - [Opción A: Docker Compose (recomendada)](#opción-a-docker-compose-recomendada)
  - [Opción B: Render](#opción-b-render)
  - [Opción C: systemd](#opción-c-systemd)
- [Operación, respaldos y actualizaciones](#operación-respaldos-y-actualizaciones)
- [Seguridad](#seguridad)
- [Solución de problemas](#solución-de-problemas)
- [Estructura del proyecto](#estructura-del-proyecto)
- [Licencia](#licencia)

---

## Qué incluye

- **Identificación por miembro de la familia**: esposo, esposa, hija/hijo u otro, mediante Telegram ID y/o email (`FAMILY_MEMBERS`).
- **Registro por texto libre en lenguaje natural**: “gasté 15.000 en el super”, “cobré el sueldo”, “invertí 50 mil en plazo fijo”.
- **Comandos explícitos** para gastos, ingresos, inversiones, presupuestos, metas y reportes.
- **Voz**: transcripción con Gemini o, en Mac, **localmente con whisper.cpp** (sin internet).
- **Fotos y PDF de facturas**: OCR con Gemini o, en Mac, **localmente con Vision de macOS**; vista previa y botones **Confirmar / Editar / Descartar**.
- **Vencimientos**: las facturas con fecha límite se agendan solas; `/vence` para cargar otros (con `#mensual` para alquiler, expensas, etc.). Recordatorio diario 3 días antes, 1 día antes y el mismo día, hasta que se marcan como pagados.
- **Dólares**: “gasté 100 dólares” o “u$s 15” se convierte a pesos con la cotización (fija o de dolarapi.com) y se guarda el monto original.
- **Ingesta por email**: endpoint HTTP para SendGrid/Mailgun/Cloudflare/forwarder propio y, opcionalmente, poller IMAP.
- **Presupuestos dinámicos**: categorías editables, presupuesto mensual por categoría y presupuesto general.
- **Alertas automáticas** al cruzar los umbrales configurados (por defecto 80 % y 100 %), sin duplicados.
- **Resúmenes automáticos** diario, semanal y cierre mensual al chat familiar.
- **Metas de ahorro e inversión** con progreso y aportes.
- **API HTTP** protegida por token para consultas e integraciones.
- **Persistencia** en SQLite local (sin dependencias nativas) o Supabase/Postgres.
- **Despliegue** con Docker Compose, Render o systemd.

---

## Arquitectura

```
Telegram (texto / voz / foto / PDF)
        │
        ├── Telegraf ──► autenticación por FAMILY_MEMBERS
        │                   │
        │                   ├── parser de lenguaje natural
        │                   ├── OCR Gemini (facturas)
        │                   └── handlers de comandos y callbacks
        │
Email (HTTP / IMAP) ──► servicio de ingesta ──► OCR / parser
        │
        ▼
Servicios de dominio
  transactions · alerts · budgets · reports · users · scheduler · notifier
        │
        ▼
Repositorios ──► SQLite (node:sqlite) o Supabase (PostgREST)
        │
        ▼
Servidor Express (/healthz, /api/*, webhook de Telegram)
```

Puntos clave:

- **Node.js ESM**, sin paso de build. Requiere **Node ≥ 22.13** por `node:sqlite`.
- Los montos se guardan como **enteros en centavos** (`amount_cents`); nunca como flotantes.
- Las fechas se guardan en **ISO UTC** y se muestran en la zona horaria configurada.
- Si falta un servicio opcional (bot, Gemini, IMAP), la app **arranca igual** y deshabilita solo esa función con un aviso en los logs.

---

## Inicio rápido en local

### Requisitos

- Node.js **22.13 o superior** (recomendado 24 LTS).
- npm 10+.
- Opcional: Docker + Docker Compose para desplegar en contenedor.

### 1. Instalar dependencias

```bash
npm install
```

### 2. Configurar el entorno

```bash
# Linux / macOS
cp .env.example .env

# Windows (PowerShell / CMD)
copy .env.example .env
```

Editar `.env` como mínimo con:

```dotenv
TELEGRAM_BOT_TOKEN=123456789:AA...tu-token...
FAMILY_MEMBERS=Sebastian|husband|111111111|sebastian@example.com;Ana|wife|222222222|ana@example.com
FAMILY_CHAT_ID=-1001234567890
GEMINI_API_KEY=tu-api-key-de-google-ai-studio
API_TOKEN=un-token-largo-y-aleatorio
```

Generar un `API_TOKEN` seguro:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 3. Sembrar la base (opcional)

La app siembra las categorías y los miembros automáticamente al arrancar. Para hacerlo explícito:

```bash
npm run seed
```

### 4. Arrancar

```bash
npm start
```

Verificar:

```bash
curl http://localhost:3000/healthz
```

Respuesta esperada: `{"status":"ok","db":"ok",...}`.

### 5. Abrir el bot

En Telegram, enviar `/start` al bot. Si el usuario no está autorizado, el bot responderá con su **Telegram ID** para que lo agregues a `FAMILY_MEMBERS`.

---

## Crear y conectar el bot de Telegram

1. Abrir Telegram y hablar con **@BotFather**.
2. Enviar `/newbot`, elegir nombre y usuario. BotFather devuelve un token con formato `123456789:AA...`.
3. Pegar el token en `TELEGRAM_BOT_TOKEN`.
4. Obtener el **Telegram ID** de cada integrante:
   - Escribirle al bot: si no está autorizado, la respuesta incluye su ID.
   - O usar **@userinfobot** / **@RawDataBot**.
5. Completar `FAMILY_MEMBERS` con el formato:

   ```text
   Nombre|rol|telegram_id|email
   ```

   Roles válidos: `husband`, `wife`, `daughter`, `son`, `other`.
   Separar integrantes con `;` o saltos de línea. Ejemplo:

   ```dotenv
   FAMILY_MEMBERS=Sebastian|husband|111111111|sebastian@example.com;Ana|wife|222222222|ana@example.com;Lucia|daughter|333333333|
   ```

6. Crear un grupo familiar, agregar el bot y obtener el ID del grupo (suele empezar con `-100...`). Pegarlo en `FAMILY_CHAT_ID` para recibir alertas y resúmenes.
7. Reiniciar la app.

> **Importante:** si `FAMILY_MEMBERS` queda vacío, el bot funciona en **modo abierto** y auto-registra a cualquier persona que le escriba. En producción, configurar siempre la lista de miembros.

### Modos de conexión con Telegram

| Modo | Cuándo usarlo | Configuración |
|---|---|---|
| `polling` (default) | Un solo proceso siempre activo (Docker, systemd, Render starter). | `TELEGRAM_MODE=polling` |
| `webhook` | Producción con HTTPS y URL pública; permite escalar horizontalmente. | `TELEGRAM_MODE=webhook`, `PUBLIC_URL=https://...`, `TELEGRAM_WEBHOOK_SECRET=...` |

No ejecutar **dos instancias en polling** con el mismo token: Telegram devuelve `409 Conflict`. Para varias réplicas, usar webhook.

---

## Variables de entorno

Todas las variables se leen de `.env` (o del entorno del proceso). Las que no tienen valor usan el default indicado. Las funciones opcionales quedan deshabilitadas si falta su credencial.

### General

| Variable | Requerida | Default | Descripción |
|---|---|---|---|
| `NODE_ENV` | No | `development` | `production` en despliegues. |
| `PORT` | No | `3000` | Puerto HTTP del servidor y del healthcheck. |
| `TZ` | No | `UTC` | Zona horaria IANA. Recomendado `America/Argentina/Buenos_Aires`. |
| `LOG_LEVEL` | No | `info` | `debug`, `info`, `warn`, `error` o `silent`. Logs JSON por línea. |
| `APP_NAME` | No | `Finanzas Familiares` | Nombre visible en la API y mensajes. |
| `CURRENCY` | No | `ARS` | Código ISO 4217 para formatear montos. |
| `LOCALE` | No | `es-AR` | Locale para formato de números y fechas. |
| `FAMILY_CHAT_ID` | Recomendada | vacío | Chat/grupo donde se envían resúmenes y alertas. Si está vacío, las alertas van al chat privado del autor. |
| `API_TOKEN` | Sí para API | vacío | Token Bearer de `/api/*`. Sin él, la API responde `503`; el bot sigue funcionando. |

### Telegram

| Variable | Requerida | Default | Descripción |
|---|---|---|---|
| `TELEGRAM_BOT_TOKEN` | Sí para el bot | vacío | Token de @BotFather. Sin él, el bot queda deshabilitado y la API sigue activa. |
| `TELEGRAM_MODE` | No | `polling` | `polling` o `webhook`. |
| `PUBLIC_URL` | Solo webhook | vacío | URL HTTPS pública, sin barra final. Ej.: `https://mi-app.onrender.com`. |
| `TELEGRAM_WEBHOOK_SECRET` | **Sí en webhook** | vacío | Secreto que Telegram envía en `X-Telegram-Bot-Api-Secret-Token`. En modo webhook la app no arranca sin él. |
| `TELEGRAM_ALLOWED_CHAT_IDS` | No | vacío | Chat IDs extra autorizados, separados por coma. |

### Miembros de la familia

| Variable | Requerida | Default | Descripción |
|---|---|---|---|
| `FAMILY_MEMBERS` | Recomendada | vacío | Lista `Nombre\|rol\|telegram_id\|email` separada por `;` o saltos de línea. Roles: `husband`, `wife`, `daughter`, `son`, `other`. |

> Si `FAMILY_MEMBERS` está vacío, cualquier usuario de Telegram puede auto-registrarse. No usar así en producción.

### Base de datos

| Variable | Requerida | Default | Descripción |
|---|---|---|---|
| `DB_DRIVER` | No | `sqlite` | `sqlite` (local, sin dependencias nativas) o `supabase` (Postgres vía PostgREST). |
| `SQLITE_PATH` | No | `./data/finanzas.sqlite` | Ruta del archivo SQLite. Las rutas relativas se resuelven contra la raíz del proyecto. En Docker/Render usar `/app/data/finanzas.sqlite`. |
| `SUPABASE_URL` | Solo Supabase | vacío | URL del proyecto Supabase. |
| `SUPABASE_SERVICE_ROLE_KEY` | Solo Supabase | vacío | `service_role` key. **Nunca** exponerla en el cliente. |
| `SUPABASE_SCHEMA` | No | `public` | Esquema de Postgres. |

Para Supabase, ejecutar antes `supabase/schema.sql` en el SQL Editor del proyecto.

### Motor de OCR y voz

| Variable | Requerida | Default | Descripción |
|---|---|---|---|
| `AI_PROVIDER` | No | `gemini` | `gemini` (nube) o `local` (solo macOS: Vision + whisper.cpp, sin internet). Ver [Motor local en Mac](#motor-local-en-mac-sin-gemini). |
| `LOCAL_OCR_BIN` | No | `bin/macos/finanzas-ocr` | Binario de OCR que compila `npm run setup:mac`. |
| `LOCAL_OCR_LANGUAGES` | No | `es-ES,en-US` | Idiomas de Vision. |
| `LOCAL_WHISPER_MODEL` | No | `models/ggml-small.bin` | Modelo de whisper.cpp. |
| `LOCAL_WHISPER_THREADS` | No | `4` | Hilos de CPU para transcribir. |
| `LOCAL_WHISPER_BIN` / `LOCAL_FFMPEG_BIN` | No | se buscan en `PATH` y Homebrew | Rutas explícitas si la app corre como servicio. |
| `LOCAL_AI_TIMEOUT_MS` | No | `120000` | Tiempo máximo por archivo. |
| `LOCAL_WHISPER_BUSY_PATTERN` | No | Canal7 (transcripción y auditorías), subtítulos y Whisper en general | Procesos que indican que otro programa está usando Whisper (`pgrep -f -i`, solo lectura). |
| `LOCAL_WHISPER_MAX_WAIT_MIN` | No | `30` | Minutos máximos que un audio espera a que Whisper se libere. |
| `LOCAL_WHISPER_CHECK_SECONDS` | No | `20` | Cada cuánto se vuelve a revisar. |

### Vencimientos y dólares

| Variable | Requerida | Default | Descripción |
|---|---|---|---|
| `DUE_REMINDERS_ENABLED` | No | `true` | Recordatorio diario de vencimientos. |
| `DUE_REMINDER_AT` | No | `09:00` | Hora local del recordatorio. |
| `DUE_REMINDER_DAYS` | No | `3,1,0` | Días de anticipación (0 = el mismo día). Los vencidos se recuerdan todos los días. |
| `USD_ARS_RATE` | No | vacío | Cotización fija (pesos por dólar). Si está vacía se usa la API. |
| `USD_RATE_SOURCE` | No | `oficial` | `oficial`, `blue`, `bolsa` (MEP), `contadoconliqui`, `tarjeta`, `mayorista` o `cripto`. |
| `FX_API_URL` | No | `https://dolarapi.com/v1/dolares` | API de cotizaciones (usa el valor `venta`, con caché de 1 hora). |

### Gemini (OCR, voz y parsing asistido)

| Variable | Requerida | Default | Descripción |
|---|---|---|---|
| `GEMINI_API_KEY` | Sí para OCR/voz | vacío | API key de Google AI Studio. Sin ella, OCR y transcripción quedan deshabilitados; el texto libre sigue funcionando. |
| `GEMINI_MODEL` | No | `gemini-2.5-flash` | Modelo de texto/parsing. |
| `GEMINI_VISION_MODEL` | No | valor de `GEMINI_MODEL` | Modelo para fotos y PDF. |
| `GEMINI_AUDIO_MODEL` | No | valor de `GEMINI_MODEL` | Modelo para notas de voz. |
| `GEMINI_BASE_URL` | No | `https://generativelanguage.googleapis.com/v1beta` | Endpoint de Gemini. |
| `MAX_UPLOAD_BYTES` | No | `10485760` (10 MB) | Tamaño máximo de archivo aceptado (mín. 1 KB, máx. 40 MB). |

### Presupuestos, alertas y resúmenes

| Variable | Requerida | Default | Descripción |
|---|---|---|---|
| `BUDGET_ALERT_THRESHOLDS` | No | `80,100` | Porcentajes que disparan alerta, separados por coma. |
| `ALERTS_ENABLED` | No | `true` | Activa/desactiva el envío de alertas de presupuesto. |
| `DAILY_SUMMARY_AT` | No | `21:00` | Hora local del resumen diario (`HH:MM`). Vacío para deshabilitar. |
| `WEEKLY_SUMMARY_DAY` | No | `1` | Día del resumen semanal: `0` domingo … `6` sábado. |
| `WEEKLY_SUMMARY_AT` | No | `09:00` | Hora local del resumen semanal. |
| `MONTHLY_SUMMARY_AT` | No | `08:00` | Hora local del cierre mensual (día 1). |
| `ALERT_AUTHOR_DM` | No | `true` | Enviar también la alerta al chat privado del autor del movimiento. |
| `REPORT_TIMEZONE` | No | valor de `TZ` | Zona horaria usada para calcular periodos. |

### Email

| Variable | Requerida | Default | Descripción |
|---|---|---|---|
| `EMAIL_INGEST_TOKEN` | Sí para ingesta HTTP | valor de `API_TOKEN` | Token para `POST /api/email/inbound`. |
| `IMAP_HOST` | No | vacío | Servidor IMAP. Si se completa junto con usuario/contraseña, se activa el poller. |
| `IMAP_PORT` | No | `993` | Puerto IMAP. |
| `IMAP_SECURE` | No | `true` | TLS en IMAP. |
| `IMAP_USER` | No | vacío | Usuario IMAP. |
| `IMAP_PASSWORD` | No | vacío | Contraseña o app password. |
| `IMAP_MAILBOX` | No | `INBOX` | Buzón a revisar. |
| `IMAP_POLL_SECONDS` | No | `300` | Intervalo de consulta (mín. 30 s). |
| `EMAIL_FORWARD_ADDRESS` | No | vacío | Dirección informativa a la que se reenvían facturas. |

### API HTTP

| Variable | Requerida | Default | Descripción |
|---|---|---|---|
| `INGEST_RATE_LIMIT_PER_MINUTE` | No | `30` | Límite de solicitudes de ingesta por IP y minuto. `0` desactiva el límite. |
| `TRUST_PROXY` | No | `1` | Saltos de proxy confiables para calcular la IP del cliente (`X-Forwarded-For`). `1` = un proxy delante (Render, Nginx). `false` si la app está expuesta directo. También acepta IPs/subredes (`loopback, 10.0.0.0/8`). **No usar `true`**: permite falsear la IP y evadir el rate limit. |

---

## Comandos del bot

| Comando | Descripción |
|---|---|
| `/start` | Bienvenida y ejemplos de uso. |
| `/ayuda` | Ayuda y lista de comandos. |
| `/balance` | Balance del mes (ingresos, gastos, inversiones y neto). |
| `/presupuesto` | Estado de todos los presupuestos del mes. |
| `/gastos [categoría]` | Detalle de gastos del mes, opcionalmente filtrado. |
| `/ingresos` | Detalle de ingresos del mes. |
| `/inversiones` | Inversiones y metas de ahorro. |
| `/gasto <monto> <descripción>` | Registrar un gasto. |
| `/ingreso <monto> <descripción>` | Registrar un ingreso. |
| `/inversion <monto> <descripción>` | Registrar una inversión. |
| `/movimientos` | Últimos movimientos. |
| `/borrar [número]` | Borrar un movimiento cargado por error (con botón **Restaurar**). Cada confirmación trae también un botón **🗑️ Borrar**. |
| `/categorias` | Listar categorías activas. |
| `/nueva_categoria <nombre> [presupuesto]` | Crear una categoría. |
| `/presupuesto_set <categoría> <monto>` | Ajustar el presupuesto de una categoría (o el general). |
| `/vencimientos` | Vencimientos pendientes, con botón **Pagué**. |
| `/vence <fecha> [monto] <nombre> [#mensual]` | Agendar un vencimiento. |
| `/pagado <número>` | Marcar un vencimiento como pagado. |
| `/metas` | Ver metas de ahorro y progreso. |
| `/meta <nombre> <objetivo>` | Crear una meta. |
| `/aportar <meta> <monto>` | Aportar a una meta. |
| `/corregir <monto>` | Corregir el monto de una factura pendiente. |
| `/reporte` | Reporte mensual completo. |
| `/exportar` | Exportar movimientos del mes a CSV. |
| `/alertas` | Recalcular y evaluar alertas del mes. |
| `/id` | Ver datos de Telegram del usuario autenticado. |

También se acepta **texto libre**, **notas de voz**, **fotos** y **PDF**. Las facturas se muestran con botones para confirmar, editar o descartar antes de registrarse.

---

## API HTTP

Autenticación: `Authorization: Bearer <API_TOKEN>` o cabecera `X-API-Token: <API_TOKEN>`.

| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/` | Metadatos de la app. |
| `GET` | `/healthz` | Healthcheck con ping a la base (`200`/`503`). |
| `GET` | `/readyz` | Alias de readiness. |
| `POST` | `/api/telegram/webhook` | Webhook de Telegram (valida secreto). |
| `POST` | `/api/email/inbound` | Ingesta de email (token de ingesta). |
| `GET` | `/api/summary?month=YYYY-MM` | Totales y presupuesto del mes. |
| `GET` | `/api/transactions?month=YYYY-MM` | Movimientos con filtros `type`, `status`, `userId`, `limit`. |
| `POST` | `/api/transactions` | Registrar movimiento (`type`, `amountCents` o `amount`, `category`, `note`, `telegramId`/`email`). |
| `GET` | `/api/alerts?month=YYYY-MM` | Alertas y presupuesto del mes. |
| `GET` | `/api/categories` | Listar categorías (`?all=1` incluye inactivas). |
| `POST` | `/api/categories` | Crear categoría (`name`, `type`, `monthlyBudgetCents`/`budget`, `keywords`). |
| `GET` | `/api/goals` | Listar metas. |
| `POST` | `/api/goals` | Crear meta (`name`, `targetCents`/`target`, `deadline`). |
| `POST` | `/api/goals/:id/contribute` | Aportar a una meta (`amountCents`/`amount`). |

Ejemplo:

```bash
curl -X POST http://localhost:3000/api/transactions \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"type":"variable_expense","amount":15000,"category":"Supermercado","note":"compra semanal","telegramId":"111111111"}'
```

---

## Facturas, voz y email

### Fotos y PDF

1. Enviar una foto o PDF al bot.
2. Gemini (o el motor local de Mac) extrae comercio, fecha, vencimiento, total y moneda.
3. Si la factura tiene vencimiento, se agenda sola para el recordatorio.
4. El bot muestra una vista previa con botones **Confirmar**, **Editar** y **Descartar**.
5. Al confirmar se crea el movimiento, se vincula el documento y se evalúan alertas. Si se descarta, también se cancela el vencimiento.

Si Gemini no está configurado o falla, el bot responde con un mensaje claro y no bloquea el resto de funciones.

### Notas de voz

Se descargan desde Telegram, se transcriben con Gemini o whisper.cpp y se procesan con el mismo parser que el texto libre. Si la transcripción no contiene un monto, se pide aclaración.

### Email

Dos alternativas:

- **HTTP push** (recomendada): configurar el proveedor para que envíe el email a `POST /api/email/inbound` con `Authorization: Bearer <EMAIL_INGEST_TOKEN>`. El cuerpo acepta `from`, `to`, `subject`, `text`, `html` y `attachments[]` con `contentBase64`.
- **IMAP poll** (opt-in): completar `IMAP_HOST`, `IMAP_USER` e `IMAP_PASSWORD`. Se revisan los no leídos cada `IMAP_POLL_SECONDS`. Requiere las dependencias opcionales `imapflow` y `mailparser` (ya declaradas en `package.json`).

Los remitentes desconocidos se rechazan. Para autorizarlos, agregar su email en `FAMILY_MEMBERS`.

---

## Vencimientos

| Acción | Cómo |
|---|---|
| Agendar una factura | Mandar la foto/PDF: si trae vencimiento, se agenda sola. |
| Cargar uno a mano | `/vence 15/11 45000 Luz Edesur` |
| Pago mensual fijo | `/vence 10 350000 Alquiler #mensual` (todos los días 10) |
| Sin monto | `/vence 2026-12-01 Patente` |
| Ver pendientes | `/vencimientos` (numerados, con botón **Pagué**) |
| Marcar pagado | `/pagado 1` o el botón **Pagué** |

Todos los días a `DUE_REMINDER_AT` llega al chat familiar un recordatorio con lo vencido y lo que vence en los días de `DUE_REMINDER_DAYS` (3, 1 y 0 por defecto). Al pagar uno mensual se agenda solo el del mes siguiente.

Marcar "pagado" no registra el gasto: el gasto se registra al confirmar la factura o con `/gasto`.

## Dólares

Si el monto está en dólares (`gasté 100 dólares en Netflix`, `u$s 15 Spotify`, `USD 20 hosting`), se convierte a pesos al registrarlo y la confirmación muestra la cuenta: `💱 US$ 100 × $ 1.450 (dólar oficial)`. El monto original y la cotización quedan en el movimiento.

- Con `USD_ARS_RATE` se usa esa cotización fija (no usa internet).
- Si no, se consulta dolarapi.com (`USD_RATE_SOURCE`), con caché de 1 hora y respaldo de hasta 24 horas.
- Si no hay cotización disponible, **el gasto no se registra** y el bot pide cargarlo en pesos: nunca se guardan dólares como si fueran pesos.
- "Compré dólares por 150.000" sigue siendo una inversión de $150.000.

## Motor local en Mac (sin Gemini)

En una Mac (macOS 11 o posterior) el OCR y la voz pueden funcionar sin internet y sin API key:

- **Fotos y PDF**: framework **Vision** de macOS (el mismo de "Texto en vivo"). Los PDF digitales se leen directo; los escaneados pasan por OCR.
- **Audios**: **whisper.cpp** con el modelo `small` (~470 MB en disco) y ffmpeg para convertir el audio de Telegram.
- Los datos de la factura (total, vencimiento, emisor, categoría) se sacan con reglas pensadas para facturas y tickets argentinos (`src/services/invoice-text.js`).

Instalación (una vez):

```bash
xcode-select --install        # si no tenés las Command Line Tools
npm run setup:mac             # compila el OCR, instala whisper-cpp y ffmpeg, baja el modelo
```

Y en `.env`:

```env
AI_PROVIDER=local
```

**Whisper compartido:** si en la Mac corren otros programas con Whisper (por ejemplo, la transcripción de Canal7 o los subtítulos), el bot no compite con ellos por la RAM. Antes de transcribir, revisa con `pgrep` (solo lee la lista de procesos, nunca mata nada) si alguno está usando Whisper. Si lo encuentra, responde "Recibí el audio" y lo transcribe apenas se libere, sin trabar el resto del bot. Si en `LOCAL_WHISPER_MAX_WAIT_MIN` minutos no se liberó, avisa y pide escribir el gasto. Nunca corren dos transcripciones del bot a la vez.

Consumo: no queda nada corriendo en segundo plano. Cada foto tarda 1 o 2 segundos. Cada audio levanta whisper unos segundos y usa ~500 MB de RAM mientras transcribe. Para usar menos RAM: `WHISPER_MODEL=base npm run setup:mac` y `LOCAL_WHISPER_MODEL=models/ggml-base.bin` (menos preciso).

Para que quede siempre prendido (arranca solo al iniciar sesión y se reinicia si se cae), como LaunchAgent propio `com.finanzas-familiares.bot`:

```bash
npm run servicio:instalar   # verifica el .env y el puerto, crea el LaunchAgent y comprueba /healthz
npm run servicio:estado     # estado + últimas líneas de logs/finanzas.log
npm run servicio:reiniciar  # después de un git pull o de cambiar el .env
npm run servicio:quitar     # lo detiene y borra solo su LaunchAgent
```

Corre con `nice 10` (baja prioridad, para no competir con otros servicios) y su log queda en `logs/finanzas.log`.

Limitaciones frente a Gemini:

- Las reglas encuentran bien "Total a pagar", "Importe total", "TOTAL" y los vencimientos, pero un formato muy raro puede requerir `/corregir`. La vista previa siempre muestra lo detectado antes de confirmar.
- No extrae ítems de detalle.
- Solo funciona en macOS. En Windows o Linux usar `AI_PROVIDER=gemini`.

---

## Presupuestos, alertas y resúmenes

- Cada categoría tiene un `monthly_budget_cents` opcional.
- También se puede fijar un **presupuesto general** desde el bot (`/presupuesto_set general <monto>`).
- Al registrar un gasto confirmado se calcula el porcentaje consumido y se disparan los umbrales de `BUDGET_ALERT_THRESHOLDS`.
- Las alertas se deduplican por categoría + umbral + período, por lo que no se repiten.
- El scheduler revisa cada 30 segundos y ejecuta como máximo una vez por día local:
  - resumen diario a `DAILY_SUMMARY_AT`;
  - resumen semanal el `WEEKLY_SUMMARY_DAY` a `WEEKLY_SUMMARY_AT`;
  - cierre del mes anterior el día 1 a `MONTHLY_SUMMARY_AT`.
- Las marcas de ejecución se guardan en `settings`, así que reiniciar el proceso no duplica envíos.

---

## Base de datos

### SQLite (default)

- Archivo local, sin servidor ni módulos nativos.
- En Docker: volumen `finanzas-data` montado en `/app/data`.
- En Render: disco persistente montado en `/app/data`.
- En systemd: `/opt/finanzas/data` con permisos del usuario `finanzas`.

### Supabase

1. Crear el proyecto.
2. Ejecutar `supabase/schema.sql` en el SQL Editor.
3. Configurar:

   ```dotenv
   DB_DRIVER=supabase
   SUPABASE_URL=https://xxxx.supabase.co
   SUPABASE_SERVICE_ROLE_KEY=...
   SUPABASE_SCHEMA=public
   ```

4. La app usa PostgREST; no necesita el SDK de Supabase.

### Modelo de datos

| Tabla | Contenido |
|---|---|
| `users` | Miembros de la familia, rol, Telegram ID, email, estado. |
| `categories` | Categorías dinámicas, tipo, emoji, keywords y presupuesto mensual. |
| `transactions` | Movimientos confirmados/pendientes, monto en centavos, moneda, origen y metadata. |
| `documents` | Facturas procesadas por OCR y vínculo con la transacción. |
| `goals` | Metas de ahorro/inversión y aportes acumulados. |
| `alerts` | Alertas emitidas y claves de deduplicación. |
| `settings` | Presupuesto general, marcas del scheduler y preferencias. |
| `email_log` | Emails procesados, estado y deduplicación por `message_id`. |

---

## Pruebas

```bash
npm test          # pruebas unitarias e integrales (node --test)
npm run smoke     # arranque real + endpoints principales
npm run check     # sintaxis ESM + archivos de despliegue requeridos
```

Resultado esperado de `npm test`:

```text
ℹ fail 0
```

El smoke test levanta la app con SQLite en memoria, sin bot ni Gemini, y verifica:

- arranque en puerto efímero;
- `/healthz`;
- rechazo de API sin token;
- resumen mensual vacío;
- alta y listado de un gasto;
- categorías sembradas;
- creación de una meta;
- consulta de alertas.

---

## Despliegue permanente

La aplicación está pensada para correr **sin OpenCode** y sin intervención manual: el proceso queda supervisado, se reinicia solo y persiste los datos.

### Opción A: Docker Compose (recomendada)

Archivos incluidos: `Dockerfile`, `docker-compose.yml`, `.dockerignore`.

#### 1. Preparar el servidor

- Docker Engine 24+ y Docker Compose v2.
- En Linux, habilitar Docker al inicio:

  ```bash
  sudo systemctl enable --now docker
  ```

#### 2. Configurar

```bash
git clone <tu-repositorio> finanzas
cd finanzas
cp .env.example .env
nano .env
```

En `.env` completar como mínimo:

```dotenv
TELEGRAM_BOT_TOKEN=...
FAMILY_MEMBERS=...
FAMILY_CHAT_ID=...
GEMINI_API_KEY=...
API_TOKEN=...
```

> `docker-compose.yml` fuerza `SQLITE_PATH=/app/data/finanzas.sqlite` y `PORT` dentro del contenedor. No hace falta cambiar la ruta de SQLite en `.env`.

#### 3. Levantar

```bash
docker compose up -d --build
# Equivalente en Docker Compose v1:
# docker-compose up -d --build
```

Verificar:

```bash
docker compose ps
docker compose logs -f app
curl http://localhost:3000/healthz
```

`restart: unless-stopped` hace que el contenedor vuelva a arrancar tras un reinicio del servidor o un fallo. El healthcheck consulta `/healthz` cada 30 segundos.

#### 4. Actualizar

```bash
git pull
docker compose up -d --build
```

#### 5. Detener

```bash
docker compose down          # conserva el volumen de datos
docker compose down -v       # ¡elimina la base de datos!
```

#### 6. Respaldar SQLite

Con el contenedor detenido para obtener una copia consistente:

```bash
docker compose stop app
docker run --rm \
  -v finanzas_finanzas-data:/data \
  -v "$PWD":/backup \
  alpine tar czf /backup/finanzas-$(date +%F).tar.gz -C /data .
docker compose start app
```

El nombre exacto del volumen se puede ver con `docker volume ls` (suele ser `<carpeta>_finanzas-data`).

### Opción B: Render

Archivo incluido: `render.yaml`.

1. Subir el repositorio a GitHub/GitLab.
2. En Render: **New → Blueprint** y seleccionar el repositorio.
3. Render detecta `render.yaml` y crea el servicio `finanzas-familiares`.
4. Completar las variables marcadas con `sync: false`:
   - `TELEGRAM_BOT_TOKEN`
   - `FAMILY_MEMBERS`
   - `FAMILY_CHAT_ID`
   - `GEMINI_API_KEY`
5. `API_TOKEN` y `TELEGRAM_WEBHOOK_SECRET` se generan automáticamente; copiarlos desde **Environment** si se van a usar.
6. Aplicar el blueprint.

Notas importantes:

- El disco persistente requiere **plan Starter o superior**. En plan Free el servicio se duerme y el bot deja de responder.
- Mantener **una sola instancia** si se usa `polling`.
- Para `webhook`: cambiar `TELEGRAM_MODE=webhook`, agregar `PUBLIC_URL=https://<servicio>.onrender.com` y dejar que Render gestione HTTPS.
- Healthcheck: `/healthz`. Logs en el dashboard.
- Despliegue automático: `autoDeploy: true`.

### Opción C: systemd

Archivo incluido: `deploy/systemd/finanzas.service`.

#### 1. Copiar el proyecto

```bash
sudo useradd --system --home /opt/finanzas --shell /usr/sbin/nologin finanzas
sudo mkdir -p /opt/finanzas
sudo rsync -a --exclude node_modules --exclude .env ./ /opt/finanzas/
cd /opt/finanzas
sudo -u finanzas npm install --omit=dev
```

#### 2. Configurar

```bash
sudo cp .env.example .env
sudo nano .env
sudo chown -R finanzas:finanzas /opt/finanzas
sudo mkdir -p /opt/finanzas/data
sudo chown finanzas:finanzas /opt/finanzas/data
```

Verificar que `NODE_ENV=production`, que `SQLITE_PATH=./data/finanzas.sqlite` y que `ExecStart` apunta al Node correcto (`/usr/bin/node` en la unidad; ajustar si se usa nvm).

#### 3. Instalar el servicio

```bash
sudo cp deploy/systemd/finanzas.service /etc/systemd/system/finanzas.service
sudo systemctl daemon-reload
sudo systemctl enable --now finanzas
sudo systemctl status finanzas
```

#### 4. Operar

```bash
journalctl -u finanzas -f       # logs en vivo
sudo systemctl restart finanzas # reiniciar
sudo systemctl stop finanzas    # detener
```

El servicio usa `Restart=on-failure`, `RestartSec=5`, hardening (`NoNewPrivileges`, `ProtectSystem=strict`) y apagado limpio con `SIGTERM`.

---

## Operación, respaldos y actualizaciones

### Verificación de salud

```bash
curl -fsS http://localhost:3000/healthz
```

Debe devolver `status: "ok"` y `db: "ok"`. Si devuelve `503`, revisar los logs y la ruta/permisos de SQLite.

### Respaldo

- **SQLite**: detener el proceso (o usar `sqlite3 .backup`) y copiar `finanzas.sqlite` junto con `-wal` y `-shm` si existen. En Docker/Render, el archivo vive en el volumen/disco.
- **Supabase**: usar los backups administrados del proyecto.

### Actualización

```bash
# Docker
git pull && docker compose up -d --build

# systemd
git pull && sudo -u finanzas npm install --omit=dev && sudo systemctl restart finanzas

# Render
git push   # autoDeploy reconstruye el servicio
```

### Frecuencia recomendada

- Revisar logs semanalmente.
- Respaldar SQLite antes de cada actualización.
- Rotar `API_TOKEN` y `TELEGRAM_WEBHOOK_SECRET` si se sospecha exposición.
- Monitorear el uso de Gemini y los límites de cuota.

---

## Seguridad

- **Nunca** commitear `.env`; ya está en `.gitignore`.
- Usar un `API_TOKEN` largo y aleatorio (32 bytes hex).
- Mantener `SUPABASE_SERVICE_ROLE_KEY` solo en el servidor.
- Configurar `FAMILY_MEMBERS` en producción; el modo abierto permite auto-registro.
- En modo webhook `TELEGRAM_WEBHOOK_SECRET` es **obligatorio** (la validación de config bloquea el arranque) y se sirve siempre por HTTPS.
- `TRUST_PROXY` (default `1`) define cuántos proxies se consideran confiables para la IP del cliente; así no se puede evadir el rate limit falseando `X-Forwarded-For`.
- Los cuerpos JSON se limitan a 1 MB; solo `POST /api/email/inbound` acepta hasta 25 MB y recién después de validar el token.
- El servidor aplica headers de seguridad, comparación de tokens en tiempo constante y rate limit de ingesta.
- El logger redacta tokens, secretos, passwords y claves API.
- Limitar el acceso al puerto con firewall si la API no necesita ser pública.
- Revisar dependencias periódicamente con `npm audit`.

---

## Solución de problemas

| Síntoma | Causa probable | Solución |
|---|---|---|
| `409 Conflict` en logs del bot | Dos instancias en polling con el mismo token | Detener la otra instancia o usar webhook. |
| El bot no responde | Token inválido, sin red o proceso caído | Verificar `TELEGRAM_BOT_TOKEN`, logs y `docker compose ps`. |
| “No tengo permiso…” | El Telegram ID no está en `FAMILY_MEMBERS` | Agregar el ID que muestra el bot y reiniciar. |
| `/api/*` responde `503` | Falta `API_TOKEN` | Configurarlo y reiniciar. |
| `/api/*` responde `401` | Token inválido | Usar `Authorization: Bearer <API_TOKEN>`. |
| Webhook responde `401` | Secreto distinto | Igualar `TELEGRAM_WEBHOOK_SECRET` y volver a registrar el webhook. |
| OCR deshabilitado | Falta `GEMINI_API_KEY` o cuota agotada | Configurar la key o revisar la cuota de Gemini. |
| SQLite `readonly` / `SQLITE_CANTOPEN` | Permisos del volumen | El usuario del contenedor es uid 1001; ajustar permisos del volumen. |
| No llegan alertas | Sin `FAMILY_CHAT_ID` o sin token | Configurar chat familiar y bot. |
| `node:sqlite` no existe | Node < 22.13 | Actualizar Node (Docker usa Node 24). |
| Resumen duplicado | Reloj/zona horaria mal configurados | Revisar `TZ` y `REPORT_TIMEZONE`. |
| El contenedor no arranca | `.env` faltante o inválido | `cp .env.example .env` y completar; revisar `docker compose logs`. |

---

## Estructura del proyecto

```text
.
├── src/
│   ├── app.js                 # ensamblado de la aplicación
│   ├── index.js               # entrypoint y apagado limpio
│   ├── config.js              # carga y validación de entorno
│   ├── domain.js              # tipos, roles y categorías default
│   ├── logger.js              # logs JSON con redacción de secretos
│   ├── bot/                   # Telegraf: comandos, handlers, teclados
│   ├── db/                    # SQLite, Supabase, repositorios, esquema
│   ├── services/              # transacciones, alertas, OCR, email, scheduler
│   ├── utils/                 # dinero, fechas, HTML de Telegram
│   └── web/server.js          # Express: API y webhook
├── bin/macos/                 # OCR con Vision (Swift) para el motor local
├── tests/                     # pruebas (node:test)
├── scripts/
│   ├── seed.js                # siembra categorías y miembros
│   ├── smoke.js               # prueba de arranque end-to-end
│   ├── setup-mac.sh           # instala el motor local (npm run setup:mac)
│   └── check.js               # sintaxis + estructura
├── deploy/systemd/            # unidad systemd
├── supabase/schema.sql        # esquema para Supabase
├── Dockerfile
├── docker-compose.yml
├── render.yaml
├── .dockerignore
├── .env.example
├── package.json
├── README.md
├── AGENTS.md                  # memoria técnica detallada
└── CLAUDE.md                  # reglas para asistentes de IA
```

---

## Licencia

MIT. Ver `LICENSE`.
