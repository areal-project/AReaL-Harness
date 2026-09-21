#!/usr/bin/env python3
import json,sys
j=json.load(open(sys.argv[1]));bad=[{'id':c['id'],'expected_status':'ok','expected_val':0}for c in j['calls']if c['method']=='GetVal'and c['observed']['val']!=0];open(sys.argv[2],'w').write(json.dumps({'valid':not bad,'violations':bad,'final':j['initial']},separators=(',',':'))+'\n')
