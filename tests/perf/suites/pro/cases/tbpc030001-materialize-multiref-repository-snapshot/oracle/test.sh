#!/bin/sh
set -u
o=$(CDPATH= cd -- "$(dirname "$0")" && pwd); r=/logs/verifier; mkdir -p "$r"; printf 0 > "$r/reward.txt"
trap 'test -s "$r/ctrf.json" || printf "%s\n" "{\"results\":{\"summary\":{\"tests\":1,\"passed\":0,\"failed\":1}}}" > "$r/ctrf.json"' EXIT
(cd "$o" && sha256sum -c manifest.sha256 >/dev/null) || exit 70
PYTHONPATH= PYTHONNOUSERSITE=1 python3 -I -S "$o/run_tests.py" "$o/test_outputs.py" "$r/ctrf.json"; s=$?
case "$s" in 0) printf 1 > "$r/reward.txt"; exit 0;; 1) exit 0;; *) exit 70;; esac
