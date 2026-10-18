#!/usr/bin/env python3
import chess,json,sys
j=json.load(open(sys.argv[1]));out=[]
for x in j['cases']:
 b=chess.Board(x['fen']);ss=[]
 for m in sorted(b.legal_moves,key=lambda z:z.uci()):
  if b.is_castling(m)or b.is_en_passant(m)or m.promotion:continue
  c=b.copy();c.push(m);ss.append({'move':m.uci(),'fen':c.fen(en_passant='fen')})
 out.append({'id':x['id'],'successors':ss})
open(sys.argv[2],'w').write(json.dumps({'cases':out},separators=(',',':'))+'\n')
