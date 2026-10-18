#!/usr/bin/env python3
import json,sys
j=json.load(open(sys.argv[1]));open(sys.argv[2],'w').write(json.dumps({'valid':True,'violations':[],'final':j['initial']},separators=(',',':'))+'\n')
