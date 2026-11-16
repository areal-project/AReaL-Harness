"""Append versioned Skill instructions without changing original task/media parts."""
import hashlib
import json
import os
import time
from datetime import datetime, timezone
from pathlib import Path

def sha(data):
    return hashlib.sha256(data).hexdigest()

def append_instructions(inputs, runtime, output):
    original = json.dumps(inputs, ensure_ascii=False, separators=(',', ':')).encode()
    skills = runtime / 'cc-blender-skills'
    manifest = json.loads((runtime / 'cc-skill-manifest.json').read_text())
    for relative, expected in manifest['skill_files_sha256'].items():
        actual = sha((skills / relative).read_bytes())
        if actual != expected:
            raise RuntimeError('Bundled Skill integrity differs: ' + relative)
    text = (runtime / 'cc-skill-instructions.md').read_text().replace('{{SKILLS_ROOT}}', str(skills))
    phase_budget = int(os.environ.get('ARENA_AGENT_TIMEOUT_SEC', '7200'))
    elapsed = max(0, time.monotonic() - float(os.environ.get('AREAL_ARENA_PHASE_STARTED_MONOTONIC', time.monotonic())))
    work_remaining = max(0, phase_budget - 600 - elapsed)
    deadline = datetime.fromtimestamp(time.time()+work_remaining, timezone.utc).isoformat()
    text += ('\n\n# Execution time and closeout\n'
        + 'Native work remaining at task start: '+str(int(work_remaining))+' seconds; UTC deadline '+deadline+'. '
        + 'Use the last 15 minutes of this work time to save the final scene at the original required delivery path, '
        + 'reopen it in Blender, run the public contract checks, and report completion honestly. '
        + 'Do not begin another broad refinement loop near the deadline. Preserve a usable editable scene early. '
        + 'The runner separately reserves 600 seconds of the outer phase for collection. '
        + 'A saved file alone is not a completed task; finish with the actual validation evidence.\n')
    result = [*inputs, {'type': 'text', 'text': text}]
    if len(json.dumps(result, ensure_ascii=False, indent=2).encode()) > 4128768:
        raise RuntimeError('Skill instructions exceed original input carrier capacity')
    receipt = {
        'schema': 'cc-blender-skill-input/v1', 'harness_ref': {
            'key': os.environ.get('ARENA_HARNESS_KEY'), 'version': os.environ.get('ARENA_HARNESS_VERSION')},
        'upstream_commit': manifest['upstream_commit'], 'parent_harness_ref': manifest['parent_harness_ref'],
        'original_input_parts_sha256': sha(original), 'original_input_parts_count': len(inputs),
        'original_input_parts_unchanged': result[:-1] == inputs,
        'injected_instructions_sha256': sha(text.encode()), 'injected_instructions_bytes': len(text.encode()),
        'skill_names': manifest['skill_names'], 'skill_files_verified': len(manifest['skill_files_sha256']),
        'transport': 'additional initial native input text part', 'usage_verified': False,
        'usage_verification': 'Inspect tool reads and implementation in native trace; injection alone is not proof of application'}
    receipt['native_skill_discovery'] = json.loads((runtime/'native-skill-discovery.json').read_text())
    (output / 'cc-skill-receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
    (output / 'cc-skill-input.txt').write_text(text)
    return result
