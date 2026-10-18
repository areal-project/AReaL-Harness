#!/bin/bash
set -euo pipefail
export LC_ALL=C.UTF-8
if [ "$#" -ne 2 ]; then exit 2; fi
input=$(realpath "$1")
output=$2
test ! -e "$output"
/usr/bin/gawk -f /app/legacy/rollup.awk "$input" > "$output"
