#!/bin/sh
set -u
mkdir -p /logs/verifier
PYTHONPATH=/tests /usr/bin/python3 /tests/test_outputs.py >/logs/verifier/test-output.log 2>&1; rc=$?; cat /logs/verifier/test-output.log
if [ "$rc" -eq 0 ]; then reward=1; pass=1; fail=0; else reward=0; pass=0; fail=1; fi
printf '%s' "$reward" >/logs/verifier/reward.txt
printf '{"results":{"summary":{"tests":1,"passed":%s,"failed":%s}}}\n' "$pass" "$fail" >/logs/verifier/ctrf.json
exit 0
