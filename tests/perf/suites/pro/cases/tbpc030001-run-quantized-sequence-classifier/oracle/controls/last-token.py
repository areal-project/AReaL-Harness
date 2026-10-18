#!/usr/bin/env python3
import json,sys
m=json.load(open(sys.argv[1]));q=json.load(open(sys.argv[2]));out=[]
for r in q['requests']:
 t=r['text'].lower().split()[-1];h=m['embeddings'][m['vocabulary'].get(t,m['unknown'])];z=[b+sum(x*y for x,y in zip(w,h)) for w,b in zip(m['weights'],m['bias'])];i=max(range(len(z)),key=z.__getitem__);out.append({'id':r['id'],'label':m['labels'][i],'logits':z})
json.dump({'version':1,'results':out},open(sys.argv[3],'w'),separators=(',',':'));open(sys.argv[3],'a').write('\n')
