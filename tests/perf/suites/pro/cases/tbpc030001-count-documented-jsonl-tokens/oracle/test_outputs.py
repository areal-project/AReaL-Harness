import json,os,tempfile,time,unittest
from pathlib import Path
from process_runner import run_limited
EXE=Path('/app/documented-token-counter')
def tokenize(s):
 x=json.loads(Path('/app/public/tokenizer/tokenizer.json').read_text());seq=[bytes([b]) for b in s.encode()];merges=[(bytes.fromhex(m['left']),bytes.fromhex(m['right']),bytes.fromhex(m['result'])) for m in x['merges']]
 while True:
  chosen=None
  for a,b,r in merges:
   if any(seq[i]==a and seq[i+1]==b for i in range(len(seq)-1)):chosen=(a,b,r);break
  if not chosen:return len(seq)
  a,b,r=chosen;out=[];i=0
  while i<len(seq):
   if i+1<len(seq) and seq[i]==a and seq[i+1]==b:out.append(r);i+=2
   else:out.append(seq[i]);i+=1
  seq=out
def fixture(root):
 doc={'version':1,'configurations':[{'name':'main','format':'jsonl','domain_field':'domain','fields':['title','text'],'domains':['code','math']}]}
 rows=[{'domain':'code','title':'the thing','text':'integer integer'},{'domain':'math','title':'on to','text':'界🙂'},{'domain':'code','title':None,'text':''}]
 query={'version':1,'configuration':'main','queries':[{'id':'joined','domains':['code','math'],'fields':['title','text'],'combine':'lf_join'},{'id':'separate','domains':['code'],'fields':['text'],'combine':'separate'}]}
 for name,x in [('doc.json',doc),('query.json',query)]: (root/name).write_text(json.dumps(x,separators=(',',':'))+'\n')
 (root/'data.jsonl').write_text(''.join(json.dumps(x,separators=(',',':'),ensure_ascii=False)+'\n' for x in rows));return doc,rows,query
def check_schema(g,q):
 assert list(g)==['version','results'] and g['version']==1 and len(g['results'])==len(q['queries'])
 for x,z in zip(g['results'],q['queries']):
  assert list(x)==['id','rows','fields','total'] and x['id']==z['id'] and [list(v) for v in x['fields']]==[['name','tokens']]*len(z['fields']) and [v['name'] for v in x['fields']]==z['fields']
class Tests(unittest.TestCase):
 def test_01_executable(self):self.assertTrue(EXE.is_file() and os.access(EXE,os.X_OK))
 def test_02_truth(self):
  root=Path(tempfile.mkdtemp());_,rows,q=fixture(root);out=root/'result.json';before=[(p.stat().st_ino,p.read_bytes()) for p in (root/'doc.json',root/'data.jsonl',root/'query.json')];cp=run_limited([EXE,root/'doc.json',root/'data.jsonl',root/'query.json',out]);self.assertEqual(cp.returncode,0,cp.stderr);self.assertEqual(cp.stdout+cp.stderr,'');raw=out.read_bytes();self.assertTrue(raw.endswith(b'\n') and not raw.endswith(b'\n\n'));got=json.loads(raw);check_schema(got,q);self.assertEqual(got['results'][0]['rows'],3)
  present=lambda r:[r[f] for f in ('title','text') if r[f] is not None];self.assertEqual(got['results'][0]['fields'],[{'name':f,'tokens':sum(tokenize(r[f]) for r in rows if r[f] is not None)} for f in ('title','text')]);self.assertEqual(got['results'][0]['total'],sum(tokenize('\n'.join(present(r))) for r in rows));self.assertEqual(got['results'][1]['fields'],[{'name':'text','tokens':sum(tokenize(r['text']) for r in rows if r['domain']=='code')}]);self.assertEqual(got['results'][1]['total'],sum(tokenize(r['text']) for r in rows if r['domain']=='code'));self.assertEqual(before,[(p.stat().st_ino,p.read_bytes()) for p in (root/'doc.json',root/'data.jsonl',root/'query.json')]);self.assertEqual({p.name for p in root.iterdir()},{'doc.json','data.jsonl','query.json','result.json'})
 def test_03_empty_and_stale(self):
  root=Path(tempfile.mkdtemp());fixture(root);(root/'data.jsonl').write_bytes(b'');out=root/'result.json';out.mkdir();(out/'junk').write_text('x');self.assertEqual(run_limited([EXE,root/'doc.json',root/'data.jsonl',root/'query.json',out]).returncode,0);self.assertEqual([x['rows'] for x in json.loads(out.read_text())['results']],[0,0])
 def test_04_invalid(self):
  for bad in (b'{}\n',b'\xff\n',b'{"domain":"code","title":"x","text":"y"}',b'{"domain":"code","domain":"math","title":"x","text":"y"}\n'):
   root=Path(tempfile.mkdtemp());fixture(root);(root/'data.jsonl').write_bytes(bad);out=root/'result.json';out.write_text('stale');self.assertNotEqual(run_limited([EXE,root/'doc.json',root/'data.jsonl',root/'query.json',out]).returncode,0);self.assertFalse(out.exists())
  for name,bad in [('doc.json',{'version':1,'configurations':False}),('query.json',{'version':1,'configuration':'main','queries':[{'id':'bad','domains':'code','fields':['text'],'combine':'separate'}]})]:
   root=Path(tempfile.mkdtemp());fixture(root);(root/name).write_text(json.dumps(bad,separators=(',',':'))+'\n');out=root/'result.json';out.write_text('stale');self.assertNotEqual(run_limited([EXE,root/'doc.json',root/'data.jsonl',root/'query.json',out]).returncode,0);self.assertFalse(out.exists())
 def test_05_alias(self):
  root=Path(tempfile.mkdtemp());fixture(root);ip=root/'data.jsonl';self.assertNotEqual(run_limited([EXE,root/'doc.json',ip,root/'query.json',ip]).returncode,0);alias=root/'alias';os.link(ip,alias);self.assertNotEqual(run_limited([EXE,root/'doc.json',ip,root/'query.json',root/'out']).returncode,0);alias.unlink();target=root/'target';target.write_text('keep');out=root/'out';out.symlink_to(target);self.assertEqual(run_limited([EXE,root/'doc.json',ip,root/'query.json',out]).returncode,0);self.assertEqual(target.read_text(),'keep')
 def test_06_escaped_cleanup(self):
  root=Path(tempfile.mkdtemp());script=root/'fork.py';pidfile=root/'pid';script.write_text("#!/usr/bin/python3\nimport os,sys,time\np=os.fork()\nif p==0:\n os.setsid();open(sys.argv[1],'w').write(str(os.getpid()));time.sleep(30)\ntime.sleep(float(sys.argv[2]))\n") ;script.chmod(0o755)
  run_limited([script,pidfile,'0']);pid=int(pidfile.read_text());self.assertFalse((Path('/proc')/str(pid)).exists());pidfile.unlink()
  with self.assertRaises(AssertionError):run_limited([script,pidfile,'30'],timeout=.2)
  pid=int(pidfile.read_text());self.assertFalse((Path('/proc')/str(pid)).exists())
if __name__=='__main__':unittest.main()
