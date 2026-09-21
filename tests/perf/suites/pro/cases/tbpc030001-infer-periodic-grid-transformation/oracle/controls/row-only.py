#!/usr/bin/env python3
import json,sys
c=json.load(open(sys.argv[1]));colors=[2,5,4];json.dump([[v or colors[r%3] for v in row] for r,row in enumerate(c['query'])],open(sys.argv[2],'w'));open(sys.argv[2],'a').write('\n')
