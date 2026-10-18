import json,os,subprocess,tempfile,unittest
from pathlib import Path
BIN=Path('/app/prove_semiring.py')
def c(n):return {'const':n}
def v(x):return {'var':x}
def op(k,a,b):return {k:[a,b]}
def poly(x,vs):
 z=(0,)*len(vs)
 if 'const' in x:return {} if x['const']==0 else {z:x['const']}
 if 'var' in x:q=list(z);q[vs.index(x['var'])]=1;return {tuple(q):1}
 a,b=(poly(y,vs) for y in x[next(iter(x))]);d={}
 if 'add' in x:
  for p,n in list(a.items())+list(b.items()):d[p]=d.get(p,0)+n
 else:
  for p,n in a.items():
   for q,m in b.items():r=tuple(i+j for i,j in zip(p,q));d[r]=d.get(r,0)+n*m
 return {p:n for p,n in d.items() if n}
def term(p):return [{'coefficient':n,'powers':list(k)} for k,n in sorted(p.items())]
def nodes(x,vs,path='',out=None):
 if out is None:out=[]
 if 'add' in x or 'mul' in x:
  k=next(iter(x));nodes(x[k][0],vs,path+'L',out);nodes(x[k][1],vs,path+'R',out)
 out.append({'path':path,'polynomial':term(poly(x,vs))});return out
class T(unittest.TestCase):
 def check(self,s,t,vs):
  with tempfile.TemporaryDirectory() as td:
   a=Path(td)/'a';o=Path(td)/'o';a.write_text(json.dumps({'version':1,'variables':vs,'source':s,'target':t},separators=(',',':'))+'\n');self.assertEqual(subprocess.run([BIN,a,o],timeout=20).returncode,0)
   expected={'version':1,'source_nodes':nodes(s,vs),'target_nodes':nodes(t,vs),'normal_form':term(poly(s,vs))}
   self.assertEqual(o.read_bytes(),(json.dumps(expected,separators=(',',':'))+'\n').encode())
 def test_01_distribute(self):self.check(op('mul',v('x'),op('add',v('y'),c(2))),op('add',op('mul',v('x'),v('y')),op('mul',c(2),v('x'))),['x','y'])
 def test_02_nested(self):self.check(op('mul',op('add',v('a'),v('b')),op('add',v('a'),v('b'))),op('add',op('add',op('mul',v('a'),v('a')),op('mul',v('a'),v('b'))),op('add',op('mul',v('b'),v('a')),op('mul',v('b'),v('b')))),['a','b'])
 def test_03_invalid(self):
  with tempfile.TemporaryDirectory() as td:
   a=Path(td)/'a';o=Path(td)/'o';a.write_text('{"version":1,"variables":["x"],"source":{"const":true},"target":{"const":1}}\n');self.assertNotEqual(subprocess.run([BIN,a,o]).returncode,0);self.assertFalse(os.path.lexists(o))
 def test_04_nodes(self):
  with tempfile.TemporaryDirectory() as td:
   td=Path(td);a=td/'a';o=td/'o';a.write_text('{}\n');os.mkfifo(o)
   try:self.assertNotEqual(subprocess.run([BIN,a,o],timeout=2).returncode,0)
   except subprocess.TimeoutExpired:self.fail('candidate timeout on special output node')
   self.assertTrue(o.exists())
 def test_05_invalid_expression_matrix(self):
  bad=[{'version':1,'variables':['x'],'source':{'var':'y'},'target':{'var':'y'}},{'version':1,'variables':['x'],'source':{'const':True},'target':{'const':1}},{'version':1,'variables':['x'],'source':{'const':1},'target':{'const':2}},{'version':1,'variables':['x','x'],'source':{'var':'x'},'target':{'var':'x'}}]
  tree={'var':'x'}
  for _ in range(81):tree={'add':[tree,{'const':0}]}
  bad.append({'version':1,'variables':['x'],'source':tree,'target':tree})
  for x in bad:
   with tempfile.TemporaryDirectory() as td:
    a=Path(td)/'a';o=Path(td)/'o';a.write_text(json.dumps(x,separators=(',',':'))+'\n');o.write_text('stale');self.assertNotEqual(subprocess.run([BIN,a,o],timeout=5).returncode,0);self.assertFalse(os.path.lexists(o))
