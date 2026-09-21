import ctypes,os,signal,subprocess,tempfile,time
def ppid(pid):
 try:s=open(f"/proc/{pid}/stat").read();return int(s[s.rfind(')')+2:].split()[1])
 except Exception:return None
def children():return {int(n) for n in os.listdir('/proc') if n.isdigit() and ppid(int(n))==os.getpid()}
def run_limited(argv,timeout,pass_fds=()):
 ctypes.CDLL(None).prctl(36,1,0,0,0);base=children();o=tempfile.TemporaryFile(mode='w+');e=tempfile.TemporaryFile(mode='w+');p=subprocess.Popen(argv,stdout=o,stderr=e,text=True,start_new_session=True,pass_fds=pass_fds)
 try:p.wait(timeout=timeout)
 except subprocess.TimeoutExpired:
  try:os.killpg(p.pid,signal.SIGKILL)
  except ProcessLookupError:pass
  p.wait()
 end=time.time()+1
 while time.time()<end:
  live=children()-base
  if not live:break
  for child in live:
   try:os.kill(child,signal.SIGKILL)
   except ProcessLookupError:pass
  try:
   while os.waitpid(-1,os.WNOHANG)[0]:pass
  except ChildProcessError:pass
  time.sleep(.01)
 o.seek(0);e.seek(0);out,err=o.read(),e.read();o.close();e.close();return subprocess.CompletedProcess(argv,p.returncode,out,err)
