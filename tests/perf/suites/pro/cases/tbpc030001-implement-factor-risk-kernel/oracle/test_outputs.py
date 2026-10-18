import fcntl,hashlib,json,math,os,random,stat,tempfile,time,unittest
from pathlib import Path
from process_runner import run_limited
LIB=Path('/app/factor_kernel.so');HERE=Path(__file__).resolve().parent
def digest(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def snapshot():
 fd=os.open(LIB,os.O_RDONLY|os.O_NOFOLLOW);s=os.fstat(fd)
 if not stat.S_ISREG(s.st_mode) or s.st_size<64 or s.st_size>2_000_000:os.close(fd);raise AssertionError('library must be a bounded regular file')
 data=b''
 while len(data)<s.st_size:
  chunk=os.read(fd,min(65536,s.st_size-len(data)))
  if not chunk:break
  data+=chunk
 os.close(fd)
 if len(data)!=s.st_size or data[:5]!=b'\x7fELF\x02' or int.from_bytes(data[18:20],'little')!=62:raise AssertionError('library must be x86-64 ELF64')
 m=os.memfd_create('candidate-kernel',os.MFD_ALLOW_SEALING);os.write(m,data);os.fchmod(m,0o555);fcntl.fcntl(m,fcntl.F_ADD_SEALS,fcntl.F_SEAL_WRITE|fcntl.F_SEAL_GROW|fcntl.F_SEAL_SHRINK|fcntl.F_SEAL_SEAL);return m,hashlib.sha256(data).hexdigest()
def case(n,k,seed):
 rng=random.Random(seed);w=[rng.uniform(-.5,.7) for _ in range(n)];r=[rng.uniform(-.2,.3) for _ in range(n)];e=[rng.uniform(-1,1) for _ in range(n*k)];a=[[rng.uniform(-1,1) for _ in range(k)] for _ in range(k)];f=[sum(a[q][i]*a[q][j] for q in range(k))/k+(0.02 if i==j else 0) for i in range(k) for j in range(k)];s=[rng.uniform(.01,.2) for _ in range(n)];return w,r,e,f,s
def evaluate(n,k,seed):
 fd,h=snapshot();td=tempfile.TemporaryDirectory();os.chmod(td.name,0o755);w,r,e,f,s=case(n,k,seed);inp=Path(td.name)/'input.json';inp.write_text(json.dumps({'kind':'factor','n':n,'k':k,'w':w,'r':r,'e':e,'f':f,'s':s}),encoding='utf-8');os.chmod(inp,0o444);q=run_limited(['/usr/bin/setpriv','--reuid=65534','--regid=65534','--clear-groups','/usr/bin/python3',str(HERE/'kernel_probe.py'),f'/proc/self/fd/{fd}',str(inp)],10,pass_fds=(fd,));os.close(fd)
 try:o=json.loads(q.stdout) if q.returncode==0 else None
 except Exception:o=None
 td.cleanup();assert o is not None,(q.returncode,q.stderr,'child produced no structured result');return w,r,e,f,s,o,h
class Tests(unittest.TestCase):
 def test_01_factor_truth_and_gradient(self):
  for n,k,seed in ((1,1,2),(5,2,7),(13,4,11),(41,7,17),(256,32,21)):
   w,r,e,f,s,o,h=evaluate(n,k,seed);self.assertEqual(o['rc'],0);self.assertIs(o['preserved'],True);x=[math.fsum(e[i*k+q]*w[i] for i in range(n)) for q in range(k)];y=[math.fsum(f[q*k+p]*x[p] for p in range(k)) for q in range(k)];er=math.fsum(w[i]*r[i] for i in range(n));ev=math.fsum(x[q]*y[q] for q in range(k))+math.fsum(s[i]*w[i]*w[i] for i in range(n));eg=[2*(math.fsum(e[i*k+q]*y[q] for q in range(k))+s[i]*w[i]) for i in range(n)];self.assertTrue(math.isclose(o['return'],er,rel_tol=3e-12,abs_tol=3e-12));self.assertTrue(math.isclose(o['variance'],ev,rel_tol=3e-12,abs_tol=3e-12));self.assertTrue(all(math.isclose(o['gradient'][i],eg[i],rel_tol=3e-12,abs_tol=3e-12) for i in range(n)))
 def test_02_specific_and_cross_factor_terms(self):
  w,r,e,f,s,o,h=evaluate(9,3,81);self.assertGreater(sum(abs(x) for x in o['gradient']),0)
 def test_03_library_regular_and_stable(self):
  before=digest(LIB);fd,h=snapshot();os.close(fd);self.assertEqual(before,h);self.assertEqual(before,digest(LIB))
 def test_04_process_cleanup(self):
  with tempfile.TemporaryDirectory() as td:
   p=Path(td);pid=p/'pid';x=p/'h.py';x.write_text("import os,sys,time\np=os.fork()\nif p:raise SystemExit\nos.setsid();open(sys.argv[1],'w').write(str(os.getpid()));time.sleep(30)\n");run_limited(['/usr/bin/python3',str(x),str(pid)],2)
   for _ in range(100):
    if pid.exists():break
    time.sleep(.01)
   self.assertTrue(pid.exists());self.assertFalse(Path('/proc',pid.read_text()).exists())
 def test_05_repeat_sealed_snapshot(self):
  for _ in range(2):fd,h=snapshot();os.close(fd)
if __name__=='__main__':unittest.main()
