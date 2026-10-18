from pathlib import Path
import sys

case = Path(sys.argv[1]); output = Path(sys.argv[2])
stock = (case / "STOCK.DAT").read_bytes(); requests = (case / "REQUESTS.DAT").read_bytes()
rows=[]
for offset in range(0,len(stock),23):
    r=stock[offset:offset+23]; rows.append([r[:6],r[6:10],int(r[10:16]),int(r[16:22]),r[22:23]])
by_item={r[0]:r for r in rows}; audit=bytearray()
for offset in range(0,len(requests),17):
    request=requests[offset:offset+17]; op=request[4:5]; item=request[5:11]; qty=int(request[11:17]); row=by_item.get(item); accepted=False; result=0
    if row is not None:
        if op==b"A" and qty<=row[2]-row[3]: row[3]+=qty; accepted=True
        if op==b"R" and qty<=row[3]: row[3]-=qty; accepted=True
        row[4]=b"Y" if row[3]==row[2] else b"N"; result=row[3]
    audit += request + (b"Y" if row is not None else b"N") + f"{result:06d}".encode()
output.mkdir(); (output/"AUDIT.DAT").write_bytes(audit)
(output/"STOCK.DAT").write_bytes(b"".join(r[0]+r[1]+f"{r[2]:06d}{r[3]:06d}".encode()+r[4] for r in rows))
