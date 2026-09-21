from pathlib import Path
import sys

case = Path(sys.argv[1]); output = Path(sys.argv[2])
stock = (case / "STOCK.DAT").read_bytes(); requests = (case / "REQUESTS.DAT").read_bytes()
rows = []
for offset in range(0, len(stock), 23):
    record = stock[offset:offset + 23]
    rows.append([record[:6], record[6:10], int(record[10:16]), int(record[16:22]), record[22:23]])
initial = {row[0]: row[:] for row in rows}
final = {row[0]: row for row in rows}
audit = bytearray()
for offset in range(0, len(requests), 17):
    request = requests[offset:offset + 17]; op=request[4:5]; item=request[5:11]; qty=int(request[11:17])
    snapshot = initial.get(item); row = final.get(item); accepted = False; result = 0
    if snapshot is not None:
        if op == b"A" and qty <= snapshot[2] - snapshot[3]: row[3] += qty; accepted = True
        if op == b"R" and qty <= snapshot[3]: row[3] -= qty; accepted = True
        row[4] = b"Y" if row[3] == row[2] else b"N"; result = row[3]
    audit += request + (b"Y" if accepted else b"N") + f"{result:06d}".encode()
output.mkdir()
(output / "AUDIT.DAT").write_bytes(audit)
(output / "STOCK.DAT").write_bytes(b"".join(r[0]+r[1]+f"{r[2]:06d}{r[3]:06d}".encode()+r[4] for r in rows))
