#!/usr/bin/python3
import json,sys
doc=json.load(open(sys.argv[1]));rows=[json.loads(x) for x in open(sys.argv[2])];q=json.load(open(sys.argv[3]));c=doc['configurations'][0];result=[]
for x in q['queries']:
 selected=[r for r in rows if r[c['domain_field']] in x['domains']];fields=[{'name':f,'tokens':sum(len(r[f].encode()) for r in selected if r[f] is not None)} for f in x['fields']];result.append({'id':x['id'],'rows':len(selected),'fields':fields,'total':sum(z['tokens'] for z in fields)})
open(sys.argv[4],'w').write(json.dumps({'version':1,'results':result},separators=(',',':'))+'\n')
