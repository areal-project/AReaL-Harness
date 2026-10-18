#!/usr/bin/env python3
import importlib.util,json,sys,unittest
from pathlib import Path
if len(sys.argv)!=3:raise SystemExit(70)
try:s=importlib.util.spec_from_file_location('tests',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
except Exception as e:print(f'evaluator import failure: {e}',file=sys.stderr);raise SystemExit(70)
r=unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromModule(m));n=r.testsRun;f=len(r.failures)+len(r.errors)+len(r.unexpectedSuccesses);k=len(r.skipped);Path(sys.argv[2]).write_text(json.dumps({'results':{'summary':{'tests':n,'passed':n-f-k,'failed':f,'skipped':k}}},separators=(',',':'))+'\n');raise SystemExit(0 if r.wasSuccessful() else 1)
