#!/usr/bin/env python3
import json,sys
m=json.load(open(sys.argv[1]));q=json.load(open(sys.argv[2]));json.dump({'version':1,'results':[{'id':r['id'],'label':m['labels'][0],'logits':[0]*len(m['labels'])} for r in q['requests']]},open(sys.argv[3],'w'),separators=(',',':'));open(sys.argv[3],'a').write('\n')
