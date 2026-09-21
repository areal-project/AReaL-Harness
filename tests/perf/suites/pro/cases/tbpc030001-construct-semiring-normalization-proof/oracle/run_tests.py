#!/usr/bin/env python3
import importlib.util,json,sys,unittest
from pathlib import Path
if len(sys.argv)!=3: raise SystemExit(70)
try:
 spec=importlib.util.spec_from_file_location("task_tests",sys.argv[1]);mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod)
except Exception as e: print(f"evaluator import failure: {e}",file=sys.stderr);raise SystemExit(70)
r=unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromModule(mod));f=len(r.failures)+len(r.errors)+len(r.unexpectedSuccesses);s=len(r.skipped);n=max(r.testsRun,f+s)
Path(sys.argv[2]).write_text(json.dumps({"results":{"summary":{"tests":n,"passed":n-f-s,"failed":f,"skipped":s}}},separators=(",",":"))+"\n")
raise SystemExit(0 if r.wasSuccessful() else 1)
