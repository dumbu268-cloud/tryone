#!/usr/bin/env bash
# Tile replay screenshots into one contact sheet per tag: one row per scenario,
# one column per checkpoint. Usage: scripts/contact-sheet.sh <tag> <scenario...>
set -euo pipefail
FF="${FFMPEG:-ffmpeg}"
TAG="$1"; shift
DIR="e2e/__artifacts__/replay/$TAG"
ROWS=()
for sc in "$@"; do
  files=("$DIR/$sc"-*.png)
  inputs=(); filters=""; i=0
  for f in "${files[@]}"; do inputs+=(-i "$f"); filters+="[$i:v]scale=320:180[s$i];"; i=$((i+1)); done
  chain=""; for ((j=0;j<i;j++)); do chain+="[s$j]"; done
  "$FF" -hide_banner -loglevel error -y "${inputs[@]}" -filter_complex "${filters}${chain}hstack=inputs=$i" "$DIR/row-$sc.png"
  ROWS+=("$DIR/row-$sc.png")
done
inputs=(); for r in "${ROWS[@]}"; do inputs+=(-i "$r"); done
if [ "${#ROWS[@]}" -gt 1 ]; then
  "$FF" -hide_banner -loglevel error -y "${inputs[@]}" -filter_complex "vstack=inputs=${#ROWS[@]}" "$DIR/sheet.png"
else
  cp "${ROWS[0]}" "$DIR/sheet.png"
fi
echo "$DIR/sheet.png"
