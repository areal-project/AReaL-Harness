#!/bin/bash
set -euo pipefail
export LC_ALL=C.UTF-8
if [ "$#" -ne 2 ]; then exit 2; fi
case_dir=$(realpath "$1")
output_dir=$2
test ! -e "$output_dir"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cp "$case_dir/STOCK.DAT" "$work/STOCK.DAT"
cp "$case_dir/REQUESTS.DAT" "$work/REQUESTS.DAT"
/usr/bin/cobc -x -free -o "$work/allocate" /app/legacy/allocate.cbl >/dev/null 2>&1
(cd "$work" && ./allocate >/dev/null 2>/dev/null)
mkdir "$output_dir"
cp "$work/STOCK.OUT" "$output_dir/STOCK.DAT"
cp "$work/AUDIT.OUT" "$output_dir/AUDIT.DAT"
