from pathlib import Path
import sys

source=Path(sys.argv[1]); output=Path(sys.argv[2]); cases={}
for line in source.read_text().splitlines():
    f=line.split("\t"); op,cid=f[:2]
    if op=="OPEN": cases[cid]={"owner":f[2],"score":int(f[3]),"state":"OPEN","events":1,"tags":[]}; continue
    c=cases[cid]; c["events"]+=1
    if op=="ADD": c["score"]+=int(f[2])
    elif op=="OWNER": c["owner"]=f[2]
    elif op=="TAG": c["tags"].append(f[2])
    elif op=="CLOSE": c["state"]="CLOSED"
    elif op=="REOPEN": c["state"]="OPEN"
lines=[]
for cid in sorted(cases):
    c=cases[cid]; lines.append("|".join((cid,c["owner"],c["state"],str(c["score"]),str(c["events"]),",".join(c["tags"]))))
output.write_text("\n".join(lines)+"\n")
