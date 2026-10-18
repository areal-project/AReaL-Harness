#!/usr/bin/env python3
import importlib.util,json,sys,unittest
from pathlib import Path
if len(sys.argv)!=3:raise SystemExit(70)
try:
 spec=importlib.util.spec_from_file_location("task_tests",sys.argv[1]);mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod)
except Exception as e:print(f"evaluator import failure: {e}",file=sys.stderr);raise SystemExit(70)
r=unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromModule(mod));failed=len(r.failures)+len(r.errors)+len(r.unexpectedSuccesses);skipped=len(r.skipped);total=max(r.testsRun,failed+skipped)
Path(sys.argv[2]).write_text(json.dumps({"results":{"summary":{"tests":total,"passed":total-failed-skipped,"failed":failed,"skipped":skipped}}},separators=(",",":"))+"\n")
raise SystemExit(0 if r.wasSuccessful() else 1)
