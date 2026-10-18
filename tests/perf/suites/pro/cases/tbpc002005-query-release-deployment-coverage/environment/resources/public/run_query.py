#!/usr/bin/env python3
import sys
from pathlib import Path
from rdflib import Graph

if len(sys.argv)!=3: raise SystemExit("usage: run_query.py QUERY GRAPH")
graph=Graph(); graph.parse(sys.argv[2],format="turtle")
result=graph.query(Path(sys.argv[1]).read_text(encoding="utf-8"))
print("\t".join(str(item) for item in result.vars))
for row in result: print("\t".join(str(item) for item in row))
