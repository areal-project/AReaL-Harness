import hashlib,itertools,json,os,subprocess,tempfile,unittest
from pathlib import Path
PROGRAM=Path('/app/assemble_protein_cassette.py');DOMAIN=False
def fixture(two=False):
 x={'version':1,'components':[{'id':'flag','peptide':'MK'},{'id':'snap','peptide':'GA'}],'linkers':['G','GS'],'codons':{'M':['ATG'],'K':['AAA','AAG'],'G':['GGT','GGC'],'S':['TCT'],'A':['GCT']},'forbidden':['AAAAAA'],'gc_min':20,'gc_max':70}
 if two:x={'version':1,'components':[{'id':'x','peptide':'AG'},{'id':'y','peptide':'SM'},{'id':'z','peptide':'K'}],'linkers':['G'],'codons':x['codons'],'forbidden':['CCCC'],'gc_min':20,'gc_max':80}
 return x
def boundary(over=False):
 return {'version':1,'components':[{'id':'x','peptide':'AAAAA' if not over else 'AAAA'},{'id':'y','peptide':'AAAAA' if not over else 'AAAA'}],'linkers':['A'],'codons':{'A':['GCT','GCC','GCA'] if not over else ['GCT','GCC','GCA','GCG']},'forbidden':[],'gc_min':0,'gc_max':100}
def truth(x):
 order=x['components'];best=None
 for links in itertools.product(x['linkers'],repeat=len(order)-1):
  prot=''.join(c['peptide']+(links[i]if i<len(links)else'')for i,c in enumerate(order))
  for cod in itertools.product(*(x['codons'][a]for a in prot)):
   dna=''.join(cod);gc=sum(c in'GC'for c in dna);pct=100*gc//len(dna)
   if any(z in dna for z in x['forbidden'])or not x['gc_min']<=pct<=x['gc_max']:continue
   k=(abs(2*gc*100-(x['gc_min']+x['gc_max'])*len(dna)),dna,[c['id']for c in order],list(links))
   if best is None or k<best[0]:best=(k,{'version':1,'protein':prot,'dna':dna,'linkers':list(links),'gc_percent':pct})
 return best[1]
def invoke(root,x):
 p=root/'in';o=root/'out';p.write_text(json.dumps(x,separators=(',',':'))+'\n');r=subprocess.run(['python3',str(PROGRAM),str(p),str(o)],capture_output=True,text=True,timeout=20);return p,o,r
class T(unittest.TestCase):
 def valid(self,x):
  with tempfile.TemporaryDirectory()as d:p,o,r=invoke(Path(d),x);self.assertEqual(r.returncode,0,r.stderr);self.assertEqual(o.read_bytes(),(json.dumps(truth(x),separators=(',',':'))+'\n').encode());self.assertTrue(p.exists())
 def test_01_truth(self):self.valid(fixture())
 def test_02_second_truth(self):self.valid(fixture(True));self.valid(boundary())
 def test_03_invalid(self):
  for x in ({},{**fixture(),'gc_min':True},{**fixture(),'codons':{'M':['ATG']}},{**fixture(),'extra':1},{**fixture(),'forbidden':['ATG']},boundary(True)):
   with tempfile.TemporaryDirectory()as d:p,o,r=invoke(Path(d),x);self.assertNotEqual(r.returncode,0);self.assertFalse(o.exists());self.assertTrue(p.exists())
 def test_04_alias_stale(self):
  with tempfile.TemporaryDirectory()as d:
   root=Path(d);p=root/'in';p.write_text(json.dumps(fixture(),separators=(',',':'))+'\n');h=hashlib.sha256(p.read_bytes()).digest();q=root/'out';os.link(p,q);self.assertNotEqual(subprocess.run(['python3',str(PROGRAM),str(p),str(q)]).returncode,0);self.assertEqual(hashlib.sha256(p.read_bytes()).digest(),h);q.unlink();q.write_text('stale');self.assertEqual(subprocess.run(['python3',str(PROGRAM),str(p),str(q)]).returncode,0);q.unlink();os.mkfifo(q);self.assertNotEqual(subprocess.run(['python3',str(PROGRAM),str(p),str(q)]).returncode,0);self.assertTrue(q.is_fifo())
 def test_05_argc(self):self.assertNotEqual(subprocess.run(['python3',str(PROGRAM)]).returncode,0)
if __name__=='__main__':unittest.main()
