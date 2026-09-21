import hashlib,json,os,socket,stat,subprocess,tempfile,unittest
from pathlib import Path
APP=Path('/app/run_classifier.py')
def dump(p,x):p.write_text(json.dumps(x,separators=(',',':'))+'\n')
def model(dim=4):
 return {'version':1,'vocabulary':{'good':0,'bad':1,'movie':2,'unknown':3},'unknown':3,'embeddings':[[2,1,0,-1],[-2,0,1,2],[1,1,1,1],[0,-1,0,1]],'labels':['negative','positive','mixed'],'weights':[[-2,0,1,1],[2,1,0,-1],[0,2,2,0]],'bias':[1,-1,0]}
def expected(m,reqs):
 out=[]
 for r in reqs:
  ids=[m['vocabulary'].get(x,m['unknown']) for x in r['text'].lower().split(' ') if x];pool=[sum(m['embeddings'][i][j] for i in ids) for j in range(len(m['embeddings'][0]))];log=[m['bias'][k]+sum(x*y for x,y in zip(m['weights'][k],pool)) for k in range(len(m['labels']))];best=max(range(len(log)),key=lambda k:(log[k],-k));out.append({'id':r['id'],'label':m['labels'][best],'logits':log})
 return {'version':1,'results':out}
class T(unittest.TestCase):
 def invoke(self,reqs):
  with tempfile.TemporaryDirectory() as td:
   p=Path(td);a=p/'m';b=p/'q';o=p/'o';m=model();dump(a,m);dump(b,{'version':1,'requests':reqs});before=(a.read_bytes(),b.read_bytes());q=subprocess.run([APP,a,b,o],timeout=10);self.assertEqual(q.returncode,0);self.assertEqual((a.read_bytes(),b.read_bytes()),before);self.assertEqual(o.read_bytes(),(json.dumps(expected(m,reqs),separators=(',',':'))+'\n').encode())
 def test_01_batch_truth(self):self.invoke([{'id':'a','text':'GOOD movie'},{'id':'b','text':'bad   unknown'},{'id':'c','text':'movie movie'}])
 def test_02_unknown_and_tie(self):self.invoke([{'id':'x','text':'zzz'},{'id':'y','text':'good bad'}])
 def test_03_invalid_matrix(self):
  m=model();q={'version':1,'requests':[{'id':'a','text':'good'}]};cases=[({'version':1,'vocabulary':m['vocabulary'],'unknown':True,'embeddings':m['embeddings'],'labels':m['labels'],'weights':m['weights'],'bias':m['bias']},q),({**m,'vocabulary':{'good':1,'bad':0}},q),(m,{'version':1,'requests':[{'id':'a','text':'good'},{'id':'a','text':'bad'}]}),(m,{'version':1,'requests':[{'id':'a','text':'\n'}]})]
  for mm,qq in cases:
   with tempfile.TemporaryDirectory() as td:
    p=Path(td);a=p/'a';b=p/'b';o=p/'o';dump(a,mm);dump(b,qq);before=(a.read_bytes(),b.read_bytes());o.write_text('stale');self.assertNotEqual(subprocess.run([APP,a,b,o],timeout=5).returncode,0);self.assertFalse(os.path.lexists(o));self.assertEqual((a.read_bytes(),b.read_bytes()),before)
 def test_04_alias_and_nodes(self):
  with tempfile.TemporaryDirectory() as td:
   p=Path(td);a=p/'a';b=p/'b';dump(a,model());dump(b,{'version':1,'requests':[{'id':'a','text':'good'}]});before=a.read_bytes();self.assertNotEqual(subprocess.run([APP,a,b,a],timeout=5).returncode,0);self.assertEqual(a.read_bytes(),before);link=p/'link';link.symlink_to(a);o=p/'o';o.write_text('stale');self.assertNotEqual(subprocess.run([APP,link,b,o],timeout=5).returncode,0);self.assertFalse(o.exists());fifo=p/'fifo';os.mkfifo(fifo);self.assertNotEqual(subprocess.run([APP,a,b,fifo],timeout=5).returncode,0);self.assertTrue(stat.S_ISFIFO(fifo.lstat().st_mode))
 def test_05_artifact(self):self.assertTrue(APP.is_file() and not APP.is_symlink())
if __name__=='__main__':unittest.main()
