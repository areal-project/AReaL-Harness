#!/usr/bin/env python3
import chess,json,sys
j=json.load(open(sys.argv[1]));out=[]
for x in j['cases']:
 b=chess.Board(x['fen']);ss=[]
 for m in sorted(b.pseudo_legal_moves,key=lambda z:z.uci()):
  if m.promotion not in(None,chess.QUEEN):continue
  c=b.copy();c.push(m);ss.append({'move':m.uci(),'fen':c.fen(en_passant='fen')})
 out.append({'id':x['id'],'successors':ss})
open(sys.argv[2],'w').write(json.dumps({'cases':out},separators=(',',':'))+'\n')
