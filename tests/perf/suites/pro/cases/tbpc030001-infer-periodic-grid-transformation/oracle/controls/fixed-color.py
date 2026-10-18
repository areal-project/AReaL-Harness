#!/usr/bin/env python3
import json,sys
c=json.load(open(sys.argv[1]));json.dump([[v or 1 for v in row] for row in c['query']],open(sys.argv[2],'w'));open(sys.argv[2],'a').write('\n')
