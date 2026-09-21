#!/usr/bin/env python3
import json,sys
c=json.load(open(sys.argv[1]));train=c['train'];found=[]
for p in range(1,7):
 for o in range(p):
  colors=[None]*p;ok=True
  for ex in train:
   for r,row in enumerate(ex['input']):
    for x,v in enumerate(row):
     y=ex['output'][r][x]
     if v and y!=v:ok=False
     if not v:
      k=(r+x+o)%p
      if not 1<=y<=9 or colors[k] not in (None,y):ok=False
      colors[k]=y
  if ok:found.append((p,o,tuple(1 if v is None else v for v in colors)))
 if found:break
p,o,colors=min(found);grid=[[v or colors[(r+x+o)%p] for x,v in enumerate(row)] for r,row in enumerate(c['query'])]
grid=[[True if v==1 else v for v in row] for row in grid]
open(sys.argv[2],'w').write(json.dumps(grid,separators=(',',':'))+'\n')
