import hashlib,json,os,shutil,socket,stat,subprocess,tempfile,unittest
from pathlib import Path
from process_runner import run_limited

APP=Path('/app/materialize_refs.py')
def run(*a): return run_limited(['python3',str(APP),*map(str,a)],timeout=30)
def git(repo,*a,binary=False):
 p=subprocess.run(['git','--git-dir',str(repo),*a],check=True,stdout=subprocess.PIPE);return p.stdout if binary else p.stdout.decode().strip()
def mkrepo(root, branches):
 repo=root/'r.git'; work=root/'w';subprocess.run(['git','init','--bare',str(repo)],check=True,stdout=subprocess.DEVNULL);subprocess.run(['git','init',str(work)],check=True,stdout=subprocess.DEVNULL)
 subprocess.run(['git','-C',str(work),'config','user.email','t@x'],check=True);subprocess.run(['git','-C',str(work),'config','user.name','T'],check=True)
 for branch,items in branches.items():
  subprocess.run(['git','-C',str(work),'checkout','--orphan',branch],check=True,stdout=subprocess.DEVNULL);subprocess.run(['git','-C',str(work),'rm','-rf','.'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
  for name,kind,data in items:
   p=work/name;p.parent.mkdir(parents=True,exist_ok=True)
   if kind=='link':os.symlink(data,p)
   else:p.write_bytes(data);p.chmod(0o755 if kind=='exec' else 0o644)
  subprocess.run(['git','-C',str(work),'add','-A'],check=True);subprocess.run(['git','-C',str(work),'commit','-m',branch],check=True,stdout=subprocess.DEVNULL);subprocess.run(['git','-C',str(work),'push',str(repo),f'HEAD:refs/heads/{branch}'],check=True,stdout=subprocess.DEVNULL)
 return repo
def expected(repo,plan):
 rows=[]
 for s in plan['snapshots']:
  c=git(repo,'rev-parse','--verify',s['ref']+'^{commit}'); ents=[]
  for rec in git(repo,'ls-tree','-rz','-r',c,binary=True).split(b'\0'):
   if not rec:continue
   h,n=rec.split(b'\t',1);mode,typ,oid=h.decode().split();ents.append({'path':n.decode(),'kind':'symlink' if mode=='120000' else 'file','mode':mode,'object':oid})
  rows.append({'name':s['name'],'ref':s['ref'],'commit':c,'entries':sorted(ents,key=lambda x:x['path'])})
 return {'schema':1,'snapshots':rows}
def fingerprint(root):
 h=hashlib.sha256()
 for base,dirs,files in os.walk(root,followlinks=False):
  for name in sorted(dirs+files):
   p=Path(base)/name;rel=p.relative_to(root).as_posix();st=os.lstat(p);h.update(f'{rel}\0{stat.S_IFMT(st.st_mode):o}\0{stat.S_IMODE(st.st_mode):o}\0'.encode())
   if stat.S_ISREG(st.st_mode):h.update(p.read_bytes())
   elif stat.S_ISLNK(st.st_mode):h.update(os.readlink(p).encode())
 return h.hexdigest()
def assert_tree(case,root,want):
 got={}
 for base,dirs,files in os.walk(root,followlinks=False):
  for name in sorted(dirs+files):
   p=Path(base)/name;rel=p.relative_to(root).as_posix();st=os.lstat(p)
   if stat.S_ISDIR(st.st_mode):got[rel]=('dir',None,None)
   elif stat.S_ISREG(st.st_mode):got[rel]=('file',stat.S_IMODE(st.st_mode),p.read_bytes())
   elif stat.S_ISLNK(st.st_mode):got[rel]=('symlink',None,os.readlink(p))
   else:got[rel]=('other',stat.S_IMODE(st.st_mode),None)
 case.assertEqual(got,want)
def noncommit_tag(repo):
 oid=subprocess.run(['git','--git-dir',str(repo),'hash-object','-w','--stdin'],input=b'blob\n',stdout=subprocess.PIPE,check=True).stdout.decode().strip()
 subprocess.run(['git','--git-dir',str(repo),'update-ref','refs/tags/blob',oid],check=True)
def gitlink_ref(repo):
 target=git(repo,'rev-parse','refs/heads/one');tree=subprocess.run(['git','--git-dir',str(repo),'mktree'],input=f'160000 commit {target}\tmodule\n'.encode(),stdout=subprocess.PIPE,check=True).stdout.decode().strip()
 env={**os.environ,'GIT_AUTHOR_NAME':'T','GIT_AUTHOR_EMAIL':'t@x','GIT_COMMITTER_NAME':'T','GIT_COMMITTER_EMAIL':'t@x'}
 commit=subprocess.run(['git','--git-dir',str(repo),'commit-tree',tree],input=b'gitlink\n',stdout=subprocess.PIPE,check=True,env=env).stdout.decode().strip();subprocess.run(['git','--git-dir',str(repo),'update-ref','refs/heads/gitlink',commit],check=True)
class Tests(unittest.TestCase):
 def setUp(self):
  self.t=Path(tempfile.mkdtemp());self.repo=ct=self.t/'none';self.repo=mkrepo(self.t,{'one':[('a.txt','file',b'A\n'),('bin/x','exec',b'#!/bin/sh\n')],'two':[('d/z','file','snow'.encode()),('d/link','link','z')]});self.plan=self.t/'p.json';self.out=self.t/'out';self.man=self.t/'m.json'
 def tearDown(self):shutil.rmtree(self.t,ignore_errors=True)
 def write(self,obj):self.plan.write_text(json.dumps(obj,separators=(',',':'))+'\n')
 def test_public_and_hidden_truth(self):
  q={'schema':1,'snapshots':[{'name':'alpha','ref':'refs/heads/one'},{'name':'beta','ref':'refs/heads/two'}]};self.write(q);self.assertEqual(run(self.repo,self.plan,self.out,self.man).returncode,0);self.assertEqual(json.loads(self.man.read_text()),expected(self.repo,q));self.assertEqual((self.out/'alpha/a.txt').read_bytes(),b'A\n');self.assertTrue(os.access(self.out/'alpha/bin/x',os.X_OK));self.assertEqual(os.readlink(self.out/'beta/d/link'),'z');self.assertFalse((self.out/'.git').exists())
  assert_tree(self,self.out,{'alpha':('dir',None,None),'alpha/a.txt':('file',0o644,b'A\n'),'alpha/bin':('dir',None,None),'alpha/bin/x':('file',0o755,b'#!/bin/sh\n'),'beta':('dir',None,None),'beta/d':('dir',None,None),'beta/d/link':('symlink',None,'z'),'beta/d/z':('file',0o644,'snow'.encode())})
 def test_invalid_cleanup_and_input_preservation(self):
  original=b'{"schema":1,"schema":1,"snapshots":[]}\n';self.plan.write_bytes(original);self.out.mkdir();(self.out/'stale').write_text('x');self.man.write_text('old');p=run(self.repo,self.plan,self.out,self.man);self.assertNotEqual(p.returncode,0);self.assertEqual(self.plan.read_bytes(),original);self.assertTrue(self.repo.exists());self.assertFalse(self.out.exists());self.assertFalse(self.man.exists())
  self.write({'schema':True,'snapshots':[]});self.assertNotEqual(run(self.repo,self.plan,self.out,self.man).returncode,0)
 def test_alias_and_missing_ref(self):
  q={'schema':1,'snapshots':[{'name':'alpha','ref':'refs/heads/nope'}]};self.write(q);before=self.plan.read_bytes();self.assertNotEqual(run(self.repo,self.plan,self.out,self.plan).returncode,0);self.assertEqual(self.plan.read_bytes(),before)
  self.write(q);os.link(self.plan,self.man);self.assertNotEqual(run(self.repo,self.plan,self.out,self.man).returncode,0);self.assertEqual(self.plan.read_bytes(),self.man.read_bytes())
 def test_format_and_tree_negatives(self):
  cases=[
   {'schema':1,'snapshots':[{'name':'../bad','ref':'refs/heads/one'}]},
   {'schema':1,'snapshots':[{'name':'ok','ref':'main'}]},
   {'schema':1,'snapshots':[{'name':'a','ref':'refs/heads/one'},{'name':'b','ref':'refs/heads/one'}]},
   {'schema':1,'snapshots':[{'name':'a','ref':'refs/tags/blob'}]},
   {'schema':1,'snapshots':[{'name':'a','ref':'refs/heads/gitlink'}]}]
  noncommit_tag(self.repo);gitlink_ref(self.repo)
  bad=mkrepo(self.t/'bad',{'absolute':[('x','link','/escape')],'escape':[('d/x','link','../../escape')]})
  for ref in ('refs/heads/absolute','refs/heads/escape'):
   self.write({'schema':1,'snapshots':[{'name':'a','ref':ref}]});self.assertNotEqual(run(bad,self.plan,self.out,self.man).returncode,0);self.assertFalse(self.out.exists());self.assertFalse(self.man.exists())
  for q in cases:
   self.write(q);self.assertNotEqual(run(self.repo,self.plan,self.out,self.man).returncode,0);self.assertFalse(self.out.exists());self.assertFalse(self.man.exists())
 def test_output_alias_containment_and_stale_nodes(self):
  q={'schema':1,'snapshots':[{'name':'a','ref':'refs/heads/one'}]};self.write(q)
  same=self.t/'same';same.write_text('stale');self.assertNotEqual(run(self.repo,self.plan,same,same).returncode,0);self.assertFalse(same.exists())
  before=self.plan.read_bytes();self.assertNotEqual(run(self.repo,self.plan,self.t,self.man).returncode,0);self.assertEqual(self.plan.read_bytes(),before)
  self.out.write_text('old');os.link(self.out,self.man);self.assertNotEqual(run(self.repo,self.plan,self.out,self.man).returncode,0);self.assertFalse(self.out.exists());self.assertFalse(self.man.exists())
  for kind in ('fifo','socket'):
   shutil.rmtree(self.t,ignore_errors=True);self.setUp();self.write({'schema':True,'snapshots':[]});self.man.write_text('stale')
   if kind=='fifo':os.mkfifo(self.out)
   elif kind=='socket':s=socket.socket(socket.AF_UNIX);s.bind(str(self.out));s.close()
   self.assertNotEqual(run(self.repo,self.plan,self.out,self.man).returncode,0);self.assertTrue(self.out.exists());self.assertFalse(self.man.exists())
  shutil.rmtree(self.t,ignore_errors=True);self.setUp();self.write(q);self.out.mkdir();(self.out/'stale').write_text('x');self.man.write_text('old');self.assertEqual(run(self.repo,self.plan,self.out,self.man).returncode,0);self.assertFalse((self.out/'stale').exists())
 def test_repository_preserved(self):
  self.write({'schema':1,'snapshots':[{'name':'alpha','ref':'refs/heads/one'}]});before=fingerprint(self.repo);self.assertEqual(run(self.repo,self.plan,self.out,self.man).returncode,0);self.assertEqual(fingerprint(self.repo),before)
 def test_runner_reaps_escaped_child(self):
  helper=self.t/'fork.py';pidfile=self.t/'pid';helper.write_text('import os,time\nif os.fork()==0:\n os.setsid();open("'+str(pidfile)+'","w").write(str(os.getpid()));time.sleep(30)\n')
  run_limited(['python3',str(helper)],timeout=5);pid=int(pidfile.read_text());self.assertFalse(Path(f'/proc/{pid}').exists())
