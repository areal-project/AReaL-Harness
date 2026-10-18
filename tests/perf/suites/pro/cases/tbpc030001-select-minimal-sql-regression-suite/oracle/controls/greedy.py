#!/usr/bin/env python3
import json,sys
j=json.load(open(sys.argv[1]));R=set(j['required']);z=[]
while R:
 x=max(j['tests'],key=lambda q:len(R&set(q['probes'])));z.append(x['id']);R-=set(x['probes'])
z=sorted(z);open(sys.argv[2],'w').write(json.dumps({'selected':z,'covered':j['required'],'count':len(z)},separators=(',',':'))+'\n')
