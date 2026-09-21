#!/bin/sh
set -u
cd /tests
result=/logs/verifier
mkdir -p "$result"
printf '0\n' > "$result/reward.txt"
trap 'test -s "$result/ctrf.json" || printf "%s\n" "{\"results\":{\"summary\":{\"tests\":1,\"passed\":0,\"failed\":1}}}" > "$result/ctrf.json"' EXIT
/usr/bin/python3.9 -I -S /tests/run_tests.py "$result/ctrf.json"
status=$?
case "$status" in
    0) printf '1\n' > "$result/reward.txt"; exit 0 ;;
    1) exit 0 ;;
    *) exit 70 ;;
esac
