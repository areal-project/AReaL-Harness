import os,sys
sys.path.insert(0,os.path.join(os.path.dirname(__file__),'vendor'))
import chess,json,socket,tempfile,unittest
from pathlib import Path
from process_runner import run_limited
E='/app/enumerate_successors.py'
FENS=[chess.STARTING_FEN,'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1','4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 2','4k3/P7/8/8/8/8/8/4K3 w - - 0 1','k3r3/8/8/8/8/8/4R3/4K3 w - - 0 1']
def fx():return {'cases':[{'id':f'c{i}','fen':f}for i,f in enumerate(FENS)]}
def truth(j):
 out=[]
 for x in j['cases']:
  b=chess.Board(x['fen']);ss=[]
  for m in sorted(b.legal_moves,key=lambda z:z.uci()):
   if m.promotion not in (None,chess.QUEEN):continue
   c=b.copy();c.push(m);ss.append({'move':m.uci(),'fen':c.fen(en_passant='fen')})
  out.append({'id':x['id'],'successors':ss})
 return {'cases':out}
def run(j,e=E):
 t=tempfile.TemporaryDirectory();p=Path(t.name);a=p/'input';o=p/'output';a.write_text(json.dumps(j,separators=(',',':'))+'\n');q=run_limited([e,str(a),str(o)],15);return t,a,o,q
def exact(o,x):assert o.read_bytes()==(json.dumps(x,separators=(',',':'))+'\n').encode()
class T(unittest.TestCase):
 def test_01_truth(self):t,a,o,q=run(fx());self.assertEqual(q.returncode,0,q.stderr);exact(o,truth(fx()));t.cleanup()
 def test_02_specials(self):
  t,a,o,q=run(fx());z=json.loads(o.read_text());moves=[{s['move']for s in c['successors']}for c in z['cases']];self.assertIn('e1g1',moves[1]);self.assertIn('e5d6',moves[2]);self.assertIn('a7a8q',moves[3]);self.assertNotIn('a7a8r',moves[3]);t.cleanup()
 def test_03_invalid(self):
  fs=[lambda j:j['cases'][0].update(id=True),lambda j:j['cases'].append(dict(j['cases'][0])),lambda j:j['cases'][0].update(extra=1),lambda j:j['cases'][0].update(fen='bad')]
  for f in fs:
   j=fx();f(j);t,a,o,q=run(j);self.assertNotEqual(q.returncode,0);self.assertFalse(o.exists());t.cleanup()
 def test_04_alias_nodes(self):
  t,a,o,q=run(fx());o.unlink();os.link(a,o);b=a.read_bytes();self.assertNotEqual(run_limited([E,str(a),str(o)],5).returncode,0);self.assertEqual(a.read_bytes(),b);t.cleanup()
  for k in ('dir','fifo','socket'):
   t,a,o,q=run(fx());o.unlink();s=None
   if k=='dir':o.mkdir()
   elif k=='fifo':os.mkfifo(o)
   else:s=socket.socket(socket.AF_UNIX);s.bind(str(o))
   self.assertNotEqual(run_limited([E,str(a),str(o)],5).returncode,0)
   if s:s.close()
   t.cleanup()
 def test_05_schema(self):
  t,a,o,q=run(fx());self.assertEqual(q.returncode,0);z=json.loads(o.read_text(),object_pairs_hook=lambda x:x);self.assertEqual(z[0][0],'cases');t.cleanup()
if __name__=='__main__':unittest.main()
