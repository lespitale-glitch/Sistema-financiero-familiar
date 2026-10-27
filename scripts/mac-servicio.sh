#!/usr/bin/env bash
# Servicio de macOS (LaunchAgent) para Finanzas Familiares.
#
#   bash scripts/mac-servicio.sh instalar   # crea y arranca el servicio (arranca solo al iniciar sesión)
#   bash scripts/mac-servicio.sh estado     # muestra si está corriendo y las últimas líneas del log
#   bash scripts/mac-servicio.sh reiniciar  # reinicia solo este servicio
#   bash scripts/mac-servicio.sh quitar     # lo detiene y borra su LaunchAgent
#
# Solo toca SU archivo: ~/Library/LaunchAgents/com.finanzas-familiares.bot.plist
# No toca LaunchAgents de Canal7 ni del servidor de medios, ni Python, ni brew.
set -euo pipefail

LABEL="com.finanzas-familiares.bot"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$ROOT/logs"
LOG="$LOG_DIR/finanzas.log"
DOMAIN="gui/$(id -u)"
PORT="$(grep -E '^PORT=' "$ROOT/.env" 2>/dev/null | tail -1 | cut -d= -f2 || true)"
PORT="${PORT:-3000}"

log() { printf '\n==> %s\n' "$1"; }
die() { printf '\nERROR: %s\n' "$1" >&2; exit 1; }

[[ "$(uname -s)" == "Darwin" ]] || die "Este script es solo para macOS."

instalar() {
  [[ -f "$ROOT/.env" ]] || die "Falta $ROOT/.env (crealo antes)."
  NODE_BIN="$(command -v node || true)"
  [[ -n "$NODE_BIN" ]] || die "No encontré node en el PATH."

  log "1/4 Verificando la configuración (sin arrancar el bot)"
  (cd "$ROOT" && "$NODE_BIN" -e "
    import('./src/config.js').then(({ loadConfig, validateConfig }) => {
      const v = validateConfig(loadConfig(process.env, { loadEnvFile: true }));
      v.warnings.forEach((w) => console.log('  aviso:', w));
      if (!v.ok) { v.errors.forEach((e) => console.error('  ERROR:', e)); process.exit(1); }
      console.log('  configuración OK');
    });
  ") || die "Corregí el .env y volvé a correr este script."

  if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    lsof -nP -iTCP:"$PORT" -sTCP:LISTEN
    die "El puerto $PORT ya está en uso (arriba se ve por quién). Si es un 'npm start' tuyo, cortalo con Ctrl+C. Si es otro programa, cambiá PORT en .env."
  fi

  log "2/4 Escribiendo $PLIST"
  mkdir -p "$LOG_DIR" "$HOME/Library/LaunchAgents"
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$ROOT/src/index.js</string>
  </array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>NODE_ENV</key><string>production</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>Nice</key><integer>10</integer>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
EOF
  plutil -lint "$PLIST" >/dev/null || die "El plist quedó mal formado."

  log "3/4 Cargando el servicio"
  launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
  launchctl bootstrap "$DOMAIN" "$PLIST"

  log "4/4 Comprobando que responda"
  for _ in $(seq 1 15); do
    if curl -fsS "http://localhost:$PORT/healthz" >/dev/null 2>&1; then
      echo "  OK: responde en http://localhost:$PORT/healthz"
      echo
      grep -E 'motor de OCR y voz|app lista|bot de Telegram' "$LOG" | tail -3 || true
      echo
      echo "Listo. Arranca solo al iniciar sesión y se reinicia si se cae."
      echo "Log: $LOG"
      return 0
    fi
    sleep 2
  done
  echo "  No respondió en 30 segundos. Últimas líneas del log:"
  tail -20 "$LOG" || true
  die "Revisá el log de arriba (el servicio queda instalado; se puede quitar con: bash scripts/mac-servicio.sh quitar)."
}

estado() {
  if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
    launchctl print "$DOMAIN/$LABEL" | grep -E '^\s*(state|pid|last exit code)' || true
  else
    echo "El servicio no está cargado."
  fi
  curl -fsS "http://localhost:$PORT/healthz" && echo || echo "No responde en el puerto $PORT."
  echo "--- últimas líneas de $LOG"
  tail -10 "$LOG" 2>/dev/null || echo "(sin log todavía)"
}

reiniciar() {
  launchctl kickstart -k "$DOMAIN/$LABEL"
  echo "Reiniciado. Revisá con: bash scripts/mac-servicio.sh estado"
}

quitar() {
  launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
  rm -f "$PLIST"
  echo "Servicio detenido y quitado. Los datos (data/) y el log quedan intactos."
}

case "${1:-}" in
  instalar) instalar ;;
  estado) estado ;;
  reiniciar) reiniciar ;;
  quitar) quitar ;;
  *) echo "Uso: bash scripts/mac-servicio.sh {instalar|estado|reiniciar|quitar}"; exit 64 ;;
esac
