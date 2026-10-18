import itertools,json,os,socket,tempfile,unittest
from pathlib import Path
from process_runner import run_limited
E='/app/select_suite.py'
def fx():return {'required':['a','b','c','d'],'tests':[{'id':'A','probes':['a','b']},{'id':'B','probes':['c']},{'id':'C','probes':['b','d']},{'id':'D','probes':['a','c','d']}]}
def truth(j):
 d={x['id']:set(x['probes'])for x in j['tests']};R=set(j['required'])
 for n in range(len(d)+1):
  for z in itertools.combinations(sorted(d),n):
   if set().union(*(d[x]for x in z))>=R:return {'selected':list(z),'covered':j['required'],'count':n}
def run(j):
 t=tempfile.TemporaryDirectory();p=Path(t.name);a=p/'i';o=p/'o';a.write_text(json.dumps(j,separators=(',',':'))+'\n');q=run_limited([E,str(a),str(o)],10);return t,a,o,q
def exact(o,x):assert o.read_bytes()==(json.dumps(x,separators=(',',':'))+'\n').encode()
class T(unittest.TestCase):
 def test_01_truth(self):j=fx();t,a,o,q=run(j);self.assertEqual(q.returncode,0,q.stderr);exact(o,truth(j));t.cleanup()
 def test_02_tie(self):
  j={'required':['x','y'],'tests':[{'id':'a','probes':['x']},{'id':'b','probes':['y']},{'id':'c','probes':['x']},{'id':'d','probes':['y']}]};t,a,o,q=run(j);self.assertEqual(q.returncode,0);exact(o,truth(j));t.cleanup()
 def test_03_invalid(self):
  for j in ({'required':[],'tests':[]},{'required':['a','a'],'tests':[]},{'required':['a'],'tests':[{'id':True,'probes':['a']}]},{'required':['a'],'tests':[{'id':'x','probes':['b']}]}):t,a,o,q=run(j);self.assertNotEqual(q.returncode,0);self.assertFalse(o.exists());t.cleanup()
 def test_04_alias_nodes(self):
  t,a,o,q=run(fx());o.unlink();os.link(a,o);self.assertNotEqual(run_limited([E,str(a),str(o)],5).returncode,0);t.cleanup()
  for kind in ('dir','fifo','socket'):
   t,a,o,q=run(fx());o.unlink();s=None
   if kind=='dir':o.mkdir()
   elif kind=='fifo':os.mkfifo(o)
   else:s=socket.socket(socket.AF_UNIX);s.bind(str(o))
   self.assertNotEqual(run_limited([E,str(a),str(o)],5).returncode,0)
   if s:s.close()
   t.cleanup()
 def test_05_stale(self):j=fx();t,a,o,q=run(j);o.write_text('x');self.assertEqual(run_limited([E,str(a),str(o)],10).returncode,0);exact(o,truth(j));t.cleanup()
if __name__=='__main__':unittest.main()
