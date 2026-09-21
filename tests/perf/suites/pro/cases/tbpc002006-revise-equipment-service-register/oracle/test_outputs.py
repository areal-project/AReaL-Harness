import random
import unittest
from pathlib import Path
from dsl_runtime import transform

PROGRAM = Path("/app/edit.program")

def set_value(fields, name, value):
    result = list(fields)
    for index, (key, current) in enumerate(result):
        if key == name:
            result[index] = (key, value)
            return result
    result.append((name, value))
    return result

def delete_value(fields, name):
    return [(key, value) for key, value in fields if key != name]

def expected_fields(fields):
    original = dict(fields)
    result = list(fields)
    if original.get("class") == "compressor" and original.get("lifecycle") == "active" and original.get("region") in {"NORTH", "EAST"}:
        result = set_value(result, "service_queue", "priority")
        if original.get("coordinator") == "legacy-desk":
            result = set_value(result, "coordinator", "reliability-desk")
    if original.get("dispatch_state") == "retired":
        result = delete_value(result, "dispatch_window")
    if original.get("class") == "valve" and original.get("criticality") == "high":
        raw = original.get("inspection_days")
        if raw is not None and int(raw) > 45:
            result = set_value(result, "inspection_days", "45")
    return result

def render(records, transform=False):
    output = ["SERVICE REGISTER — generated\n", "# outside records remains byte-exact\n"]
    for index, (identifier, fields) in enumerate(records):
        values = expected_fields(fields) if transform else fields
        output.append(f"@@ record {identifier}\n")
        for field_index, (key, value) in enumerate(values):
            output.append(f"{key}={value}\n")
            if field_index == 1:
                output.append(f"# note-{index}\n")
        output.append("@@ end\n")
        if index % 2 == 0:
            output.append("\n")
    output.append("END REGISTER\n")
    return "".join(output).encode("utf-8")

def fixture(seed):
    rng = random.Random(seed)
    tag = str(seed)
    region = "NORTH" if seed % 2 else "EAST"
    records = [
        (f"EQ-{tag}-A", [("class","compressor"),("lifecycle","active"),("region",region),("service_queue","standard"),("coordinator","legacy-desk"),("dispatch_state","retired"),("dispatch_window","night"),("memo",f"keep-{seed}")]),
        (f"EQ-{tag}-B", [("class","compressor"),("lifecycle","active"),("region","EAST"),("coordinator","modern-desk"),("dispatch_state","open"),("memo","insert queue")]),
        (f"EQ-{tag}-C", [("class","compressor"),("lifecycle","paused"),("region","NORTH"),("service_queue","standard"),("coordinator","legacy-desk")]),
        (f"EQ-{tag}-D", [("class","compressor"),("lifecycle","active"),("region","WEST"),("service_queue","standard"),("coordinator","legacy-desk")]),
        (f"EQ-{tag}-E", [("class","valve"),("criticality","high"),("inspection_days",str(46 + seed % 20)),("memo","numeric")]),
        (f"EQ-{tag}-F", [("class","valve"),("criticality","high"),("inspection_days","45")]),
        (f"EQ-{tag}-G", [("class","turbine"),("dispatch_state","retired"),("dispatch_window","day"),("memo","delete only")]),
        (f"EQ-{tag}-H", [("class","turbine"),("dispatch_state","retired"),("memo","missing delete target")]),
        (f"EQ-{tag}-I", [("class","valve"),("criticality","low"),("inspection_days","99")]),
    ]
    for index in range(60):
        equipment_class = ("compressor", "valve", "turbine", "pump")[index % 4]
        records.append((f"EQ-{tag}-X{index:02d}", [
            ("class", equipment_class),
            ("lifecycle", "active" if index % 3 else "paused"),
            ("region", ("NORTH", "EAST", "WEST")[index % 3]),
            ("service_queue", "standard"),
            ("coordinator", "legacy-desk" if index % 5 else "modern-desk"),
            ("dispatch_state", "retired" if index % 11 == 0 else "open"),
            ("dispatch_window", f"window-{index % 4}"),
            ("criticality", "high" if index % 3 == 1 else "low"),
            ("inspection_days", str(30 + (seed + index) % 40)),
            ("memo", f"bulk-{seed}-{index}"),
        ]))
    rng.shuffle(records)
    return render(records), render(records, transform=True)

def run_candidate(data):
    return transform(PROGRAM, data)

class EditTests(unittest.TestCase):
    def test_public_example(self):
        actual = run_candidate(Path("/app/public/input.txt").read_bytes())
        self.assertEqual(actual, Path("/app/public/expected.txt").read_bytes())

    def test_generated_inputs(self):
        for seed in (820003, 820018, 820031):
            with self.subTest(seed=seed):
                source, expected = fixture(seed)
                self.assertEqual(run_candidate(source), expected)

    def test_program_budget(self):
        raw = PROGRAM.read_bytes()
        self.assertLessEqual(len(raw), 4096)
        raw.decode("utf-8")
        self.assertGreater(sum(1 for line in raw.splitlines() if line.strip()), 0)
        self.assertLessEqual(sum(1 for line in raw.splitlines() if line.strip()), 12)

if __name__ == "__main__":
    unittest.main()
