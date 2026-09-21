#!/bin/sh
set -u
d=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
r=/logs/verifier
mkdir -p "$r"
printf 0 > "$r/reward.txt"
trap '[ -s "$r/ctrf.json" ] || printf "%s\n" '\''{"results":{"summary":{"tests":1,"passed":0,"failed":1}}}'\'' > "$r/ctrf.json"' EXIT
(cd "$d" && sha256sum -c manifest.sha256 >/dev/null) || exit 70
PYTHONPATH= PYTHONNOUSERSITE=1 python3 -I -S "$d/run_tests.py" "$d/test_outputs.py" "$r/ctrf.json"
x=$?
case $x in
  0) printf 1 > "$r/reward.txt"; exit 0 ;;
  1) exit 0 ;;
  *) exit 70 ;;
esac
