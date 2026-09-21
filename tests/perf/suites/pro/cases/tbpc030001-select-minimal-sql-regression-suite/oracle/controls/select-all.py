#!/usr/bin/env python3
import json,sys
j=json.load(open(sys.argv[1]));z=sorted(x['id']for x in j['tests']);open(sys.argv[2],'w').write(json.dumps({'selected':z,'covered':j['required'],'count':len(z)},separators=(',',':'))+'\n')
