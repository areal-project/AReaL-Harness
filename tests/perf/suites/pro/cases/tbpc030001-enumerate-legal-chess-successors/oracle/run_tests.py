#!/usr/bin/env python3
import importlib.util,json,sys,unittest
from pathlib import Path
t,c=map(Path,sys.argv[1:]);s=importlib.util.spec_from_file_location('tests',t);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);r=unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromModule(m));n=r.testsRun;f=min(n,len(r.failures)+len(r.errors)+len(r.unexpectedSuccesses));k=len(r.skipped);c.parent.mkdir(parents=True,exist_ok=True);c.write_text(json.dumps({'results':{'summary':{'tests':n,'passed':n-f-k,'failed':f,'skipped':k}}},separators=(',',':'))+'\n');raise SystemExit(0 if r.wasSuccessful()else 1)
