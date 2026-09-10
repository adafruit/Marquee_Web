#!/usr/bin/env bash
# Regenerate test/fixtures/{inputs,golden} with real ImageMagick.
#
# The committed goldens came from ImageMagick 7.1.2-27 Q16-HDRI on macOS. The quantize
# colour cache is coarser on Apple builds (quantize.c CacheShift 3 vs 2), so a Linux
# `magick` can legitimately produce a few different pixels; bitmap.js mirrors the
# macOS build. Inputs are PNGs given on the command line; each becomes
# <name>_<w>x<h>.rgba.gz plus 28 goldens (4 displays x 7 dither settings).
#
#   scripts/regen-goldens.sh path/to/some.png [more.png ...]
set -euo pipefail
cd "$(dirname "$0")/.."
command -v magick >/dev/null || { echo "magick not on PATH" >&2; exit 1; }
magick -version | head -1
PAL=test/fixtures/palettes
mkdir -p test/fixtures/inputs test/fixtures/golden
for png in "$@"; do
  name=$(basename "${png%.*}")
  dims=$(magick identify -format '%wx%h' "$png")
  base="${name}_${dims}"
  magick "$png" -depth 8 rgba:- | gzip -9 > "test/fixtures/inputs/${base}.rgba.gz"
  for d in mono:eink-2color gray4:eink-4gray tricolor:eink-3color quadcolor:eink-4color; do
    disp=${d%%:*}; pal=${d##*:}
    for m in "floyd85:-dither FloydSteinberg -define dither:diffusion-amount=85%" \
             "floyd50:-dither FloydSteinberg -define dither:diffusion-amount=50%" \
             "floyd1:-dither FloydSteinberg -define dither:diffusion-amount=1%" \
             "none:-dither None" \
             "o8:-ordered-dither o8x8" "o4:-ordered-dither o4x4" "o2:-ordered-dither o2x2"; do
      tag=${m%%:*}; args=${m#*:}
      # shellcheck disable=SC2086
      magick "$png" $args -remap "$PAL/$pal.png" gif:- \
        | magick gif:- -compress none BMP3:- \
        | gzip -9 > "test/fixtures/golden/${base}__${disp}__${tag}.bmp.gz"
    done
  done
  echo "wrote ${base}"
done
