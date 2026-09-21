import json,os,socket,tempfile,unittest
from pathlib import Path
from process_runner import run_limited
E='/app/validate_transcript.py'
def fx():return {'initial':{'a':1},'calls':[{'id':'s','method':'SetVal','key':'b','value':4,'observed':{'status':'ok','val':4}},{'id':'g','method':'GetVal','key':'b','value':None,'observed':{'status':'ok','val':3}},{'id':'m','method':'GetVal','key':'x','value':None,'observed':{'status':'ok','val':0}}]}
def truth(j):
 s=dict(j['initial']);bad=[]
 for c in j['calls']:
  if c['method']=='SetVal':s[c['key']]=c['value'];v=c['value']
  else:v=s.get(c['key'],0)
  if c['observed']!={'status':'ok','val':v}:bad.append({'id':c['id'],'expected_status':'ok','expected_val':v})
 return {'valid':not bad,'violations':bad,'final':dict(sorted(s.items()))}
def run(j):
 t=tempfile.TemporaryDirectory();p=Path(t.name);a=p/'i';o=p/'o';a.write_text(json.dumps(j,separators=(',',':'))+'\n');q=run_limited([E,str(a),str(o)],10);return t,a,o,q
def exact(o,x):assert o.read_bytes()==(json.dumps(x,separators=(',',':'))+'\n').encode()
class T(unittest.TestCase):
 def test_01_truth(self):j=fx();t,a,o,q=run(j);self.assertEqual(q.returncode,0,q.stderr);exact(o,truth(j));t.cleanup()
 def test_02_updates(self):
  j=fx();j['calls'][1]['observed']['val']=4;t,a,o,q=run(j);self.assertEqual(q.returncode,0);exact(o,truth(j));t.cleanup()
 def test_03_invalid(self):
  for f in (lambda j:j.update(initial={'x':True}),lambda j:j['calls'][0].update(value=2**40),lambda j:j['calls'][0].update(extra=1)):
   j=fx();f(j);t,a,o,q=run(j);self.assertNotEqual(q.returncode,0);t.cleanup()
 def test_04_alias(self):
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
