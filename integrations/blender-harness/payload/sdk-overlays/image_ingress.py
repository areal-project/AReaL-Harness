"""Shared initial-image transport using the exact versioned native encoder.

Original files are never rewritten. Host preflight and the packaged SDK call the
same SHA-bound native helper, before input-file/RPC frame construction.
"""
import base64
import hashlib
import json
from pathlib import Path
import subprocess

SCHEMA = 'input-image-ingress/v1'
MIMES = {'.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.webp':'image/webp'}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def prepare(query, sources, helper, expected_sha256, *, max_bytes=4128768):
    helper=Path(helper)
    if helper.is_symlink() or not helper.is_file() or digest(helper.read_bytes())!=expected_sha256:
        raise ValueError('Pinned input image encoder differs')
    rows=[];urls=[]
    for name, raw, mime in sources:
        if mime not in MIMES.values() or not raw:
            raise ValueError('Supported nonempty image required at input ingress')
        url='data:'+mime+';base64,'+base64.b64encode(raw).decode('ascii')
        urls.append(url);rows.append({'path':str(name),'sha256':digest(raw),'bytes':len(raw),'original_data_url_sha256':digest(url.encode())})
    if not rows: return [{'type':'text','text':query}],[]
    result=subprocess.run([str(helper)],input=json.dumps(urls).encode(),capture_output=True,timeout=60,check=True)
    prepared=json.loads(result.stdout)
    if prepared.get('schema')!=SCHEMA or len(prepared.get('images',[]))!=len(rows):
        raise ValueError('Image ingress returned a different input inventory')
    parts=[{'type':'text','text':query}]
    for row, image in zip(rows,prepared['images']):
        url=image['url'];audit=image['audit'];header,encoded=url.split(',',1);raw=base64.b64decode(encoded,validate=True)
        if audit['sourceSha256']!=row['original_data_url_sha256'] or audit['originalBytes']!=row['bytes'] or audit['sentBytes']!=len(raw) or audit.get('omitted'):
            raise ValueError('Image ingress lost original-to-transport binding')
        if len(raw)>256*1024 or len(raw)>row['bytes']:
            raise ValueError('Image ingress exceeds per-image byte budget')
        row['transport']={'schema':SCHEMA,'sha256':digest(raw),'data_url_sha256':digest(url.encode()),'bytes':len(raw),'mime':header[5:-7],'encoder_sha256':expected_sha256,'audit':audit}
        parts.extend([{'type':'text','text':'Problem image: '+Path(row['path']).name},{'type':'image','url':url}])
    size=len(json.dumps(parts,ensure_ascii=False,indent=2).encode())
    if size>max_bytes:
        raise ValueError('COMPRESSED_INPUT_CARRIER_TOO_LARGE: '+str(size)+' > '+str(max_bytes)+'; no model execution')
    return parts,rows


def configured(profile=None):
    import os
    path=profile or os.environ.get('WHITEBOX_SOLVER_PROFILE')
    if not path:return None
    value=json.loads(Path(path).read_text()).get('native_binding',{}).get('input_ingress')
    if value and value.get('schema')!=SCHEMA:raise ValueError('Unknown image ingress policy')
    return value
