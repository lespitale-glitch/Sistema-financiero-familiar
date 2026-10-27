#!/usr/bin/env bash
# Instala el motor local de OCR y voz en macOS (reemplaza a Gemini).
#
#   npm run setup:mac                 # modelo de voz "small" (recomendado)
#   WHISPER_MODEL=base npm run setup:mac   # mas liviano y menos preciso
#
# Hace:
#   1. Compila bin/macos/finanzas-ocr (Swift + Vision) con las Command Line Tools.
#   2. Instala whisper.cpp y ffmpeg con Homebrew si faltan.
#   3. Descarga el modelo de whisper a models/ (una sola vez).
#   4. Prueba los tres binarios.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MODEL_NAME="${WHISPER_MODEL:-small}"
MODEL_FILE="$ROOT/models/ggml-${MODEL_NAME}.bin"
MODEL_URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${MODEL_NAME}.bin"
OCR_SRC="$ROOT/bin/macos/finanzas-ocr.swift"
OCR_BIN="$ROOT/bin/macos/finanzas-ocr"

log() { printf '\n==> %s\n' "$1"; }
die() { printf '\nERROR: %s\n' "$1" >&2; exit 1; }

[[ "$(uname -s)" == "Darwin" ]] || die "Este script es solo para macOS."

log "1/4 Compilando el OCR con Vision"
if ! xcode-select -p >/dev/null 2>&1; then
  die "Faltan las Command Line Tools. Instalalas con: xcode-select --install (y volvé a correr este script)."
fi
swiftc -O "$OCR_SRC" -o "$OCR_BIN"
chmod +x "$OCR_BIN"
"$OCR_BIN" --version

log "2/4 whisper.cpp y ffmpeg (Homebrew)"
if ! command -v brew >/dev/null 2>&1; then
  die "No encontré Homebrew. Instalalo desde https://brew.sh y volvé a correr este script."
fi
# No instala nada por su cuenta: si falta algo, muestra el --dry-run y se frena
# para que lo revises antes (la Mac es compartida con otros servicios).
MISSING=()
command -v whisper-cli >/dev/null 2>&1 || command -v whisper-cpp >/dev/null 2>&1 || MISSING+=(whisper-cpp)
command -v ffmpeg >/dev/null 2>&1 || MISSING+=(ffmpeg)
if (( ${#MISSING[@]} > 0 )); then
  echo "Faltan: ${MISSING[*]}. Esto es lo que haría Homebrew (no se instaló nada):"
  brew install --dry-run "${MISSING[@]}" || true
  die "Revisá el --dry-run. Si está todo bien, instalá a mano con: brew install ${MISSING[*]} y volvé a correr este script."
fi
echo "whisper.cpp y ffmpeg ya están instalados (se usan tal cual, sin modificarlos)."

log "3/4 Modelo de voz: ggml-${MODEL_NAME}.bin"
mkdir -p "$ROOT/models"
if [[ -s "$MODEL_FILE" ]]; then
  echo "Ya existe $MODEL_FILE"
else
  curl -L --fail --progress-bar -o "$MODEL_FILE.part" "$MODEL_URL"
  mv "$MODEL_FILE.part" "$MODEL_FILE"
fi

log "4/4 Prueba rápida"
WHISPER_BIN="$(command -v whisper-cli || command -v whisper-cpp)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
# 1 segundo de silencio: solo verifica que ffmpeg + whisper arrancan.
ffmpeg -nostdin -hide_banner -loglevel error -f lavfi -i anullsrc=r=16000:cl=mono -t 1 -c:a pcm_s16le "$TMP/silencio.wav"
"$WHISPER_BIN" -m "$MODEL_FILE" -f "$TMP/silencio.wav" -l es -nt -np >/dev/null 2>&1 \
  && echo "whisper.cpp OK ($WHISPER_BIN)" \
  || die "whisper.cpp no pudo transcribir la prueba. Revisá: $WHISPER_BIN -m $MODEL_FILE -f $TMP/silencio.wav"

cat <<EOF

Listo. Agregá esto a tu .env:

  AI_PROVIDER=local
  LOCAL_WHISPER_MODEL=models/ggml-${MODEL_NAME}.bin

Si la app corre como servicio (launchd) y no encuentra whisper o ffmpeg, agregá también:

  LOCAL_WHISPER_BIN=$WHISPER_BIN
  LOCAL_FFMPEG_BIN=$(command -v ffmpeg)
EOF
