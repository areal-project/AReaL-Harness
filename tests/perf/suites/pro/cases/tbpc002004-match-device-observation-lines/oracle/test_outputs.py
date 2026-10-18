import json, random, re, subprocess, tempfile, unittest
from pathlib import Path

ARTIFACT=Path("/app/pattern.txt")
RUNNER=Path("/app/public/run_pattern.py")
PUBLIC=Path("/app/public/corpus.txt")

def load_pattern():
    raw=ARTIFACT.read_bytes()
    if len(raw)>2049 or not raw.endswith(b"\n") or raw.count(b"\n")!=1 or b"\r" in raw: raise AssertionError("artifact format")
    pattern=raw[:-1].decode("utf-8"); compiled=re.compile(pattern,re.MULTILINE)
    if compiled.groups!=1: raise AssertionError("capture count")
    return compiled

def valid_unit(rng): return f"unit=U-{rng.choice('ABCDEFGH')}{rng.randrange(100,1000):03d}"
def valid_slot(rng): return f"slot=S{rng.randrange(1,49):02d}"

def fixture(seed):
    rng=random.Random(seed); lines=[]; expected=[]
    modes=list(range(10))*5; rng.shuffle(modes)
    for index,mode in enumerate(modes):
        unit=valid_unit(rng); slots=[valid_slot(rng) for _ in range(1+rng.randrange(3))]
        if mode==0:
            line=f"{unit} alpha {' '.join(slots)}"; expected.append(slots[-1][5:])
        elif mode==1:
            line=f"{' / '.join(slots)} tail {unit}"; expected.append(slots[-1][5:])
        elif mode==2: line=f"unit=U-A099 {slots[0]}"
        elif mode==3: line=f"unit=U-Z500 {slots[0]}"
        elif mode==4: line=f"x{unit} {slots[0]}"
        elif mode==5: line=f"{unit} slot=S00 slot=S49 slot=S001"
        elif mode==6: line=f"{unit} x{slots[0]} {valid_slot(rng)}_"
        elif mode==7:
            line=f"Ω {unit} xslot=S14 {slots[0]}! {slots[-1]}"; expected.append(slots[-1][5:])
        elif mode==8: line=f"noise {' '.join(slots)} no-unit"
        else:
            other=valid_unit(rng); line=f"{unit} {slots[0]} {other} {slots[-1]}"; expected.append(slots[-1][5:])
        lines.append(line)
    ending="\r\n" if seed%2 else "\n"
    text=ending.join(lines)
    if seed%3: text+=ending
    return text,expected

class PatternTests(unittest.TestCase):
    def test_artifact_and_public_runner(self):
        compiled=load_pattern(); expected=json.loads(Path("/app/public/expected.json").read_text(encoding="utf-8"))
        self.assertEqual(compiled.findall(PUBLIC.read_text(encoding="utf-8")),expected)
        completed=subprocess.run(["python3",str(RUNNER),str(ARTIFACT),str(PUBLIC)],capture_output=True,text=True,timeout=10)
        self.assertEqual(completed.returncode,0,completed.stderr); self.assertEqual(json.loads(completed.stdout),expected)

    def test_generated_independent_truth(self):
        compiled=load_pattern()
        for seed in (410003,410018,410027):
            with self.subTest(seed=seed):
                corpus,expected=fixture(seed); self.assertEqual(compiled.findall(corpus),expected)

    def test_targeted_boundaries_and_line_scope(self):
        compiled=load_pattern()
        corpus=("slot=S01 unit=U-A100 slot=S48\n"
                "unit=U-H999 slot=S09_unit slot=S08\r\n"
                "unit=U-A1000 slot=S07\n"
                "unit=U-B101\nslot=S06\n"
                "Ωunit=U-A100 slot=S07β\n"
                "unit=U-E519 slot=S06 slot=S49\n"
                "unit=U-C317 slot=S04\nunit=U-D418 slot=S05")
        self.assertEqual(compiled.findall(corpus),["S48","S08","S07","S06","S04","S05"])

if __name__=="__main__": unittest.main()
