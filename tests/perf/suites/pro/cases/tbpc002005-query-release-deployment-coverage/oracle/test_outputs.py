import subprocess, unittest
from pathlib import Path
from rdflib import Graph, Literal, Namespace, URIRef
from rdflib.namespace import XSD

QUERY=Path("/app/query.rq"); EX=Namespace("http://example.org/release#")

def dated(graph,node,start,end,prefix):
    graph.add((node,EX[prefix+"Starts"],Literal(start,datatype=XSD.date)))
    if end is not None: graph.add((node,EX[prefix+"Ends"],Literal(end,datatype=XSD.date)))

def fixture(seed):
    graph=Graph(); tag=str(seed); expected=[]
    def build(label,component_specs,deployment_specs):
        release=EX[f"R{tag}_{label}"]
        for ci,verifications in enumerate(component_specs):
            component=EX[f"C{tag}_{label}_{ci}"]; graph.add((release,EX.releaseComponent,component))
            for vi,(status,start,end) in enumerate(verifications):
                verification=EX[f"V{tag}_{label}_{ci}_{vi}"]; graph.add((component,EX.componentVerification,verification)); graph.add((verification,EX.verificationStatus,Literal(status))); dated(graph,verification,start,end,"verification")
        for di,(region,code,start,end) in enumerate(deployment_specs):
            deployment=EX[f"D{tag}_{label}_{di}"]; graph.add((release,EX.releaseDeployment,deployment)); graph.add((deployment,EX.deploymentRegion,region)); graph.add((region,EX.regionCode,Literal(code))); dated(graph,deployment,start,end,"deployment")
        return release
    west=EX[f"West{tag}"]; south=EX[f"South{tag}"]; west_code=f"WEST-{seed%11}"
    component_count=3+(seed%2); q0_components=[]
    for index in range(component_count):
        copies=1+(seed%3 if index==0 else 0); q0_components.append([('pass','2030-03-31' if index==0 and seed%2 else '2029-01-01',None)]*copies)
    q0=build("A",q0_components,[(EX.RegionNorth,'NORTH','2030-03-31' if seed%2 else '2029-01-01',None),(west,west_code,'2029-01-01',None),(EX[f"WestDup{tag}"],west_code,'2029-01-01',None)])
    future_component=EX[f"C{tag}_A_future"]; future_verification=EX[f"V{tag}_A_future"]; graph.add((q0,EX.releaseComponent,future_component)); graph.add((future_component,EX.componentVerification,future_verification)); graph.add((future_verification,EX.verificationStatus,Literal('pass'))); dated(graph,future_verification,'2030-04-01',None,'verification')
    future_deployment=EX[f"D{tag}_A_future"]; future_region=EX[f"FutureRegion{tag}"]; graph.add((q0,EX.releaseDeployment,future_deployment)); graph.add((future_deployment,EX.deploymentRegion,future_region)); graph.add((future_region,EX.regionCode,Literal(f"FUTURE-{seed%5}"))); dated(graph,future_deployment,'2030-04-01',None,'deployment')
    duplicate_rows=2+(seed%3)
    build("B",[[('pass','2029-01-01',None)]*duplicate_rows,[('pass','2029-01-01',None)]*duplicate_rows],[(EX.RegionEast,'EAST','2029-01-01',None)])
    build("C",[[('pass','2029-01-01',None)]]*3,[(EX[f"WestC{tag}"],'WEST','2029-01-01',None)])
    build("D",[[('pass','2029-01-01',None)]]*3,[(EX.RegionNorth,'NORTH','2029-01-01','2030-03-30'),(EX[f"WestD{tag}"],'WEST','2029-01-01',None)])
    q4=build("E",[[('pass','2030-03-31','2030-03-31')],[('pass','2029-01-01',None)],[('pass','2029-01-01',None)]],[(EX.RegionEast,'EAST','2030-03-31','2030-03-31'),(south,'SOUTH','2029-01-01',None)])
    build("F",[[('fail','2029-01-01',None)],[('pass','2029-01-01','2030-03-30')],[('pass','2029-01-01',None)],[('pass','2029-01-01',None)]],[(EX.RegionNorth,'NORTH','2029-01-01',None)])
    build("G",[[('pass','2029-01-01',None)]]*3,[(EX.RegionNorth,'NORTH','2030-04-01',None),(EX[f"WestG{tag}"],'WEST','2029-01-01',None)])
    for release,codes,count in ((q0,["NORTH",west_code],component_count),(q4,["EAST","SOUTH"],3)):
        for code in codes: expected.append((release,Literal(code),Literal(count,datatype=XSD.integer)))
    expected.sort(key=lambda row:(str(row[0]),str(row[1])))
    return graph,expected

def execute(graph):
    result=graph.query(QUERY.read_text(encoding="utf-8"))
    if [str(v) for v in result.vars] != ["release","region","componentCount"]: raise AssertionError("variables")
    rows=list(result)
    for row in rows:
        if not isinstance(row[0],URIRef) or not isinstance(row[1],Literal) or row[1].datatype is not None or row[1].language is not None: raise AssertionError("term types")
        if not isinstance(row[2],Literal) or row[2].datatype != XSD.integer: raise AssertionError("count type")
    return rows

class QueryTests(unittest.TestCase):
    def test_public_runner(self):
        completed=subprocess.run(["python3","/app/public/run_query.py",str(QUERY),"/app/public/graph.ttl"],capture_output=True,text=True,timeout=20)
        self.assertEqual(completed.returncode,0,completed.stderr); self.assertEqual(completed.stdout,Path("/app/public/expected.tsv").read_text(encoding="utf-8"))
    def test_generated_graphs(self):
        for seed in (710003,710004,710005):
            with self.subTest(seed=seed):
                graph,expected=fixture(seed); self.assertEqual(execute(graph),expected)
    def test_artifact_is_nonempty_utf8(self):
        raw=QUERY.read_bytes(); self.assertGreater(len(raw),0); raw.decode("utf-8")

if __name__=="__main__": unittest.main()
