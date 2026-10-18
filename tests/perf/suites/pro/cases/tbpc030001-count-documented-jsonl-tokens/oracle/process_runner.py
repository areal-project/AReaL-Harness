import ctypes,os,signal,subprocess,tempfile,time
from pathlib import Path
ctypes.CDLL(None).prctl(36,1,0,0,0)
def table():
 out={}
 for p in Path('/proc').glob('[0-9]*/stat'):
  try:
   raw=p.read_text();close=raw.rfind(')');out[int(raw[:raw.find(' ')])]=int(raw[close+2:].split()[1])
  except (OSError,ValueError,IndexError):pass
 return out
def descendants(root,baseline=()):
 t=table();found={root}
 while True:
  more={p for p,q in t.items() if q in found and p not in baseline}
  if more<=found:return found-{root}
  found|=more
def reap():
 while True:
  try:p,_=os.waitpid(-1,os.WNOHANG)
  except ChildProcessError:return
  if not p:return
def run_limited(args,timeout=60):
 baseline=set(table())
 with tempfile.TemporaryFile() as so,tempfile.TemporaryFile() as se:
  p=subprocess.Popen(args,stdout=so,stderr=se,start_new_session=True);known={p.pid};deadline=time.monotonic()+timeout
  while p.poll() is None and time.monotonic()<deadline:
   known|=descendants(p.pid,baseline);time.sleep(.01)
  timed=p.poll() is None
  for pid in known|{x for x,q in table().items() if q==os.getpid() and x not in baseline}:
   try:os.kill(pid,signal.SIGKILL)
   except ProcessLookupError:pass
  try:os.killpg(p.pid,signal.SIGKILL)
  except ProcessLookupError:pass
  try:p.wait(timeout=2)
  except subprocess.TimeoutExpired:p.kill();p.wait()
  stable=0;end=time.monotonic()+2
  while time.monotonic()<end and stable<3:
   adopted={x for x,q in table().items() if q==os.getpid() and x not in baseline}
   for pid in adopted:
    try:os.kill(pid,signal.SIGKILL)
    except ProcessLookupError:pass
   reap();stable=stable+1 if not adopted else 0;time.sleep(.02)
  so.seek(0);se.seek(0)
  if timed:raise AssertionError('candidate timed out')
  if any(q==os.getpid() and x not in baseline for x,q in table().items()):raise AssertionError('candidate left descendant')
  return subprocess.CompletedProcess(args,p.returncode,so.read().decode('utf-8','replace'),se.read().decode('utf-8','replace'))
