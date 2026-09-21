#!/usr/bin/env python3
import json,math,sys
j=json.load(open(sys.argv[1]));ps=[]
for x in j['observations']:
 q=math.sqrt(sum(v*v for v in x['direction']));d=[v/q for v in x['direction']];ps.append([x['origin'][i]+x['distance']*d[i]for i in range(3)])
c=[sum(p[i]for p in ps)/len(ps)for i in range(3)];r=sum(math.dist(c,p)for p in ps)/len(ps);open(sys.argv[2],'w').write(json.dumps({'center':c,'radius':r},separators=(',',':'))+'\n')
