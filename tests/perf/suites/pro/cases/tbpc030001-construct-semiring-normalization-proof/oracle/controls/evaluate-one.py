#!/usr/bin/env python3
import json,sys
x=json.load(open(sys.argv[1]));json.dump({'version':1,'source_nodes':[{'path':'','polynomial':[{'coefficient':1,'powers':[0]*len(x['variables'])}]}],'target_nodes':[{'path':'','polynomial':[{'coefficient':1,'powers':[0]*len(x['variables'])}]}],'normal_form':[{'coefficient':1,'powers':[0]*len(x['variables'])}]},open(sys.argv[2],'w'),separators=(',',':'));open(sys.argv[2],'a').write('\n')
