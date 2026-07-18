#!/bin/sh
set -e
# Seed baked recordings into the data dir (no-clobber: live recordings on a
# persistent volume always win over image-baked copies).
mkdir -p data
for f in data-baked/*; do
  [ -e "$f" ] || continue
  base=$(basename "$f")
  [ -e "data/$base" ] || cp "$f" "data/$base"
done
exec npx tsx src/index.ts
