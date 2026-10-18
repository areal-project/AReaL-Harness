import ctypes,os,signal,subprocess,tempfile,time
from pathlib import Path
ctypes.CDLL(None).prctl(36,1,0,0,0)
def table():
 out={}
 for p in Path('/proc').glob('[0-9]*/stat'):
  try:s=p.read_text('ascii');k=s.rfind(')');out[int(s[:s.find(' ')])]=int(s[k+2:].split()[1])
  except (OSError,ValueError,IndexError):pass
 return out
def descendants(root):
 t=table();found={root};changed=True
 while changed:
  changed=False
  for pid,ppid in t.items():
   if ppid in found and pid not in found:found.add(pid);changed=True
 return found
def adopted(base):
 t=table();found={p for p,q in t.items() if p not in base and q==os.getpid()};changed=True
 while changed:
  changed=False
  for p,q in t.items():
   if p not in base and q in found and p not in found:found.add(p);changed=True
 return found
def reap():
 while True:
  try:p,_=os.waitpid(-1,os.WNOHANG)
  except ChildProcessError:return
  if p==0:return
def run_limited(args,timeout=30):
 with tempfile.TemporaryFile() as so,tempfile.TemporaryFile() as se:
  base=set(table());p=subprocess.Popen(args,stdout=so,stderr=se,start_new_session=True);known={p.pid};deadline=time.monotonic()+timeout;timed=False
  while p.poll() is None:
   known|=descendants(p.pid)
   if time.monotonic()>=deadline:timed=True;break
   time.sleep(.01)
  for pid in known|descendants(p.pid)|adopted(base):
   try:os.kill(pid,signal.SIGKILL)
   except ProcessLookupError:pass
  try:os.killpg(p.pid,signal.SIGKILL)
  except ProcessLookupError:pass
  try:p.wait(timeout=2)
  except subprocess.TimeoutExpired:p.kill();p.wait(timeout=2)
  time.sleep(.03)
  for pid in adopted(base):
   try:os.kill(pid,signal.SIGKILL)
   except ProcessLookupError:pass
  reap();so.seek(0);se.seek(0)
  if adopted(base):raise AssertionError('candidate left descendant process')
  if timed:raise AssertionError('candidate timed out')
  return subprocess.CompletedProcess(args,p.returncode,so.read().decode('utf-8','replace'),se.read().decode('utf-8','replace'))
