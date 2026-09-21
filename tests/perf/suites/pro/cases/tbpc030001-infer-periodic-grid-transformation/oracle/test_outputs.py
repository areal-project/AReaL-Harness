import json,os,stat,subprocess,tempfile,unittest
from pathlib import Path
P=Path('/app/transform_grid.py')
def model(train):
 for p in range(1,7):
  fits=[]
  for o in range(p):
   colors=[None]*p;ok=True
   for ex in train:
    for r,row in enumerate(ex['input']):
     for c,v in enumerate(row):
      y=ex['output'][r][c]
      if v and y!=v:ok=False
      if not v:
       k=(r+c+o)%p
       if not 1<=y<=9 or colors[k] not in (None,y):ok=False
       colors[k]=y
   if ok:fits.append((p,o,tuple(1 if x is None else x for x in colors)))
  if fits:return min(fits)
 raise ValueError
def apply(g,m):
 p,o,colors=m;return [[v or colors[(r+c+o)%p] for c,v in enumerate(row)] for r,row in enumerate(g)]
def case(p,o,colors,query):
 bases=[[[0,7,0,0],[0,0,8,0]],[[0,0,0],[9,0,0]]]
 train=[{'input':g,'output':apply(g,(p,o,colors))} for g in bases]
 return {'version':1,'train':train,'query':query}
def invoke(c,out,src=None):
 if src is None:src=out.parent/'case.json';src.write_text(json.dumps(c,separators=(',',':'))+'\n')
 return subprocess.run(['python3',str(P),str(src),str(out)],capture_output=True,text=True,timeout=20)
def parse(path):
 raw=path.read_bytes();assert raw.endswith(b'\n') and raw.count(b'\n')==1
 value=json.loads(raw[:-1].decode())
 assert type(value) is list and 1<=len(value)<=12 and type(value[0]) is list and 1<=len(value[0])<=12
 width=len(value[0]);assert all(type(row) is list and len(row)==width and all(type(v) is int and 0<=v<=9 for v in row) for row in value)
 return value
class T(unittest.TestCase):
 def check(self,c):
  with tempfile.TemporaryDirectory() as d:
   root=Path(d);src=root/'case.json';out=root/'out.json';src.write_text(json.dumps(c,separators=(',',':'))+'\n');before=src.read_bytes();r=invoke(c,out,src);self.assertEqual(r.returncode,0,r.stderr);self.assertEqual(parse(out),apply(c['query'],model(c['train'])));self.assertEqual(src.read_bytes(),before)
 def test_01_period_three(self):self.check(case(3,0,(2,5,4),[[0,0,1],[0,0,0]]))
 def test_02_period_four_offset(self):self.check(case(4,2,(8,3,6,1),[[0,2,0],[0,0,0],[7,0,0]]))
 def test_03_invalid_and_stale_cleanup(self):
  good=case(3,0,(2,5,4),[[0]])
  bad=[{}, {**good,'extra':1},{**good,'version':True},{**good,'query':[[False]]},{**good,'train':[good['train'][0]]},{**good,'train':[{'input':[[0]],'output':[[0]]},good['train'][1]]}]
  for c in bad:
   with self.subTest(c=c),tempfile.TemporaryDirectory() as d:
    root=Path(d);out=root/'out';out.write_text('stale');self.assertNotEqual(invoke(c,out).returncode,0);self.assertFalse(out.exists())
  with tempfile.TemporaryDirectory() as d:
   root=Path(d);src=root/'case';out=root/'out';src.write_text('{"version":1,"version":1}\n');out.write_text('stale');self.assertNotEqual(subprocess.run(['python3',str(P),str(src),str(out)]).returncode,0);self.assertFalse(out.exists())
 def test_04_alias_and_input_node(self):
  c=case(2,0,(2,3),[[0]])
  with tempfile.TemporaryDirectory() as d:
   root=Path(d);src=root/'x';src.write_text(json.dumps(c));before=src.read_bytes();self.assertNotEqual(invoke(c,src,src).returncode,0);self.assertEqual(src.read_bytes(),before);link=root/'link';link.symlink_to(src);self.assertNotEqual(invoke(c,root/'out',link).returncode,0);outlink=root/'outlink';outlink.symlink_to(src);self.assertNotEqual(invoke(c,outlink,src).returncode,0);self.assertTrue(outlink.is_symlink())
 def test_05_boolean_output_is_not_integer(self):
  with tempfile.TemporaryDirectory() as d:
   p=Path(d)/'out';p.write_text('[[true]]\n')
   with self.assertRaises(AssertionError):parse(p)
 def test_06_artifact(self):self.assertTrue(P.is_file());self.assertFalse(P.is_symlink())
if __name__=='__main__':unittest.main()
