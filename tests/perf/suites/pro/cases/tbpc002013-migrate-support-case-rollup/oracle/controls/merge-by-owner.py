from pathlib import Path
import sys

source=Path(sys.argv[1]); output=Path(sys.argv[2]); states={}; case_owner={}; case_events={}; case_tags={}; case_state={}
for line in source.read_text().splitlines():
    f=line.split("\t"); op,cid=f[:2]
    if op=="OPEN":
        owner=f[2]; case_owner[cid]=owner; states.setdefault(owner,int(f[3])); case_events[cid]=1; case_tags[cid]=set(); case_state[cid]="OPEN"
    else:
        owner=case_owner[cid]; case_events[cid]+=1
        if op=="ADD": states[owner]+=int(f[2])
        elif op=="OWNER": case_owner[cid]=f[2]; states.setdefault(f[2],states[owner])
        elif op=="TAG": case_tags[cid].add(f[2])
        elif op=="CLOSE": case_state[cid]="CLOSED"
        elif op=="REOPEN": case_state[cid]="OPEN"
lines=[]
for cid in sorted(case_owner):
    owner=case_owner[cid]; lines.append("|".join((cid,owner,case_state[cid],str(states[owner]),str(case_events[cid]),",".join(sorted(case_tags[cid])))))
output.write_text("\n".join(lines)+"\n")
