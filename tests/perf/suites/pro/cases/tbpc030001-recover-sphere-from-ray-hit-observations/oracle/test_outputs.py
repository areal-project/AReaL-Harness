import json,math,os,socket,tempfile,unittest
from pathlib import Path
from process_runner import run_limited
E='/app/recover_sphere.py'
def fx(c=[1.,-2.,3.],r=2.5):
 obs=[]
 for d in ([1,0,0],[-1,0,0],[0,1,0],[0,0,1],[1,1,1]):
  q=math.sqrt(sum(x*x for x in d));u=[x/q for x in d];p=[c[i]+r*u[i]for i in range(3)];obs.append({'origin':[p[i]+5*u[i]for i in range(3)],'direction':[-3*u[i]for i in range(3)],'distance':5.})
 return {'observations':obs}
def first(c,r,x):
 o=x['origin'];d=x['direction'];q=math.sqrt(sum(v*v for v in d));d=[v/q for v in d];oc=[o[i]-c[i]for i in range(3)];b=2*sum(oc[i]*d[i]for i in range(3));z=b*b-4*(sum(v*v for v in oc)-r*r);return min(t for t in((-b-math.sqrt(z))/2,(-b+math.sqrt(z))/2)if t>0)
def run(j,e=E):t=tempfile.TemporaryDirectory();p=Path(t.name);a=p/'i';o=p/'o';a.write_text(json.dumps(j,separators=(',',':'))+'\n');q=run_limited([e,str(a),str(o)],10);return t,a,o,q
def runraw(b,e=E):t=tempfile.TemporaryDirectory();p=Path(t.name);a=p/'i';o=p/'o';a.write_bytes(b);q=run_limited([e,str(a),str(o)],10);return t,a,o,q
def decode(o):
 b=o.read_bytes();assert b.endswith(b'\n')and b.count(b'\n')==1
 def pairs(xs):
  d={}
  for k,v in xs:assert k not in d;d[k]=v
  return d
 return json.loads(b[:-1].decode(),object_pairs_hook=pairs)
class T(unittest.TestCase):
 def test_01_predicate(self):
  for j in(fx(),fx([-4.,1.,.5],1.25)):
   t,a,o,q=run(j);self.assertEqual(q.returncode,0,q.stderr);z=decode(o);self.assertEqual(list(z),['center','radius']);self.assertIs(type(z['center']),list);self.assertEqual(len(z['center']),3);self.assertTrue(all(type(v)in(int,float)and type(v)is not bool and math.isfinite(v)and -100<=v<=100 for v in z['center']));self.assertTrue(type(z['radius'])in(int,float)and type(z['radius'])is not bool and math.isfinite(z['radius'])and 0<z['radius']<=100);self.assertTrue(all(math.isclose(first(z['center'],z['radius'],x),x['distance'],rel_tol=1e-7,abs_tol=1e-7)for x in j['observations']));t.cleanup()
 def test_02_invalid(self):
  for f in(lambda j:j['observations'][0].update(distance=True),lambda j:j.update(extra=1),lambda j:j.update(observations=j['observations'][:3]),lambda j:j.update(observations=j['observations']*13)):
   j=fx();f(j);t,a,o,q=run(j);self.assertNotEqual(q.returncode,0);t.cleanup()
  t,a,o,q=runraw(b'{"observations":[],"observations":[]}\n');self.assertNotEqual(q.returncode,0);t.cleanup()
 def test_03_alias_nodes(self):
  t,a,o,q=run(fx());o.unlink();os.link(a,o);self.assertNotEqual(run_limited([E,str(a),str(o)],5).returncode,0);t.cleanup()
  for k in('dir','fifo','socket'):
   t,a,o,q=run(fx());o.unlink();s=None
   if k=='dir':o.mkdir()
   elif k=='fifo':os.mkfifo(o)
   else:s=socket.socket(socket.AF_UNIX);s.bind(str(o))
   self.assertNotEqual(run_limited([E,str(a),str(o)],5).returncode,0)
   if s:s.close()
   t.cleanup()
  for k in('symlink','dir','fifo'):
   t,a,o,q=run(fx());real=a.with_name('real');a.rename(real)
   if k=='symlink':a.symlink_to(real)
   elif k=='dir':a.mkdir()
   else:os.mkfifo(a)
   self.assertNotEqual(run_limited([E,str(a),str(o)],5).returncode,0);t.cleanup()
 def test_04_stale(self):t,a,o,q=run(fx());o.write_text('x');self.assertEqual(run_limited([E,str(a),str(o)],10).returncode,0);t.cleanup()
 def test_05_types(self):t,a,o,q=run(fx());z=decode(o);self.assertTrue(all(type(v)in(int,float)and type(v)is not bool for v in z['center']+[z['radius']]));t.cleanup()
if __name__=='__main__':unittest.main()
