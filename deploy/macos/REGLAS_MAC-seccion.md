
======================================================================
## FINANZAS FAMILIARES  (la mantiene el chat/proyecto "Finanzas de familia")
Última actualización: 2026-10-27

### Qué es y dónde está
- Bot de Telegram de gastos de la casa (Node.js, NO usa Python).
- Carpeta: ~/Sistema-financiero-familiar (repo github.com/lespitale-glitch/Sistema-financiero-familiar).
- Base de datos: ~/Sistema-financiero-familiar/data/finanzas.sqlite (respaldar antes de mover o borrar).
- Configuración con tokens: ~/Sistema-financiero-familiar/.env (permiso 600).
- Puerto 3000 (localhost). Bot de Telegram propio (token distinto al de Searcharr y el vigilante).
- Servicio: LaunchAgent ~/Library/LaunchAgents/com.finanzas-familiares.bot.plist (27/10)
  RunAtLoad + KeepAlive, nice 10, log ~/Sistema-financiero-familiar/logs/finanzas.log.
  Manejo: npm run servicio:estado | servicio:reiniciar | servicio:quitar (desde la carpeta del proyecto).

### Qué instaló (27/10)
- bin/macos/finanzas-ocr: OCR con Vision de macOS, compilado con swiftc dentro de la carpeta del proyecto.
- models/ggml-small.bin (~470 MB): modelo de whisper.cpp, dentro de la carpeta del proyecto.
- NO instaló nada con brew: usa whisper-cli y ffmpeg de Homebrew que ya estaban, sin modificarlos.
- No usa /Volumes/M.2 500 GB ni /Volumes/Media, ni python@3.11/3.13/3.14, ni toca LaunchAgents de otros.

### RAM y Whisper
- Fotos de facturas (Vision): livianas, no usan Whisper.
- Notas de voz: whisper-cli con modelo small (~500 MB unos segundos por audio).
  SOLO arranca si `pgrep -f -i` no encuentra otro Whisper/proceso pesado corriendo
  (transcribir_pendientes, correr_auditorias_pendientes, auditoria_canal7, reauditar, extraer_vtr,
  subs_nocturno, generar_subs, fw_transcribe, mlx_whisper, faster_whisper, whisper-cli).
  Si está ocupado, espera (máx. 30 min) y nunca corre dos transcripciones propias a la vez.
  pgrep solo lee procesos: este programa nunca mata procesos de otros.

### Cómo pararlo
- npm run servicio:quitar (desde ~/Sistema-financiero-familiar), o matar solo por PID exacto
  del proceso "node .../Sistema-financiero-familiar/src/index.js". Nunca pkill por patrón.
