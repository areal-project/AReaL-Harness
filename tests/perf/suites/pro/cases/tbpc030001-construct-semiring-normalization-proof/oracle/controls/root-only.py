#!/usr/bin/env python3
import json,sys
json.dump({'version':1,'source_nodes':[],'target_nodes':[],'normal_form':[]},open(sys.argv[2],'w'),separators=(',',':'));open(sys.argv[2],'a').write('\n')
