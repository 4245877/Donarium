#!/usr/bin/env python3
"""Read-only server inventory. Temporary helper code is removed in finally.

Copies only the archive listing utility to /tmp, never a model or archive.
Saves remote metadata and member directories locally for reproducible review.
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile

SERVER = 'miha@192.168.0.141'
SSH = ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', SERVER]
BASE = Path(__file__).resolve().parent.parent
os.umask(0o077)
output = Path(sys.argv[1])
output.mkdir(parents=True, exist_ok=True, mode=0o700)
remote = subprocess.check_output(SSH + ['mktemp -d /tmp/donarium-figure-audit.XXXXXXXX'], text=True).strip()
assert remote.startswith('/tmp/donarium-figure-audit.') and remote.replace('.', '').replace('-', '').replace('/', '').isalnum()
try:
    with tempfile.TemporaryFile() as stream:
        with tarfile.open(fileobj=stream, mode='w') as archive:
            for name in ['7z', '7z.so']:
                archive.add('/usr/lib/7zip/' + name, arcname=name)
            archive.add(BASE / 'scripts/figure-link-inventory.py', arcname='inventory.py')
        stream.seek(0)
        subprocess.run(SSH + [f'tar -xf - -C {remote}'], stdin=stream, check=True)
    source = f'''
import sys,os,json,subprocess
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor,as_completed
sys.path.insert(0,{remote!r})
import inventory
tool={remote!r}+'/7z'
original=inventory.subprocess.run
def run(args,**kw):
 args[0]=tool
 return original(args,**kw)
inventory.subprocess.run=run
roots=['/srv/data/google-drive']
allfiles=[];errors=[];counts={{}};extras=[]
formats={{'.rar','.zip','.7z','.stl','.obj','.3mf','.blend','.fbx','.tar','.gz','.step','.stp','.ply','.glb','.gltf','.amf'}}
for root in roots:
 count=0;dirs=0
 for directory,children,files in os.walk(root,followlinks=False,onerror=lambda e:errors.append(str(e))):
  dirs+=1
  children[:]=[d for d in children if d not in ['.cache','.local','.git','node_modules','.npm','.mozilla','snap'] and not os.path.islink(os.path.join(directory,d))]
  for name in files:
   p=Path(directory,name)
   if p.suffix.lower() not in formats:continue
   count+=1
   if str(p).startswith('/srv/data/google-drive/Идеально/'):allfiles.append(p)
   else:extras.append(dict(path=str(p),fingerprint=inventory.fingerprint(p)))
 counts[root]=dict(filesWithModelOrArchiveExtension=count,directories=dirs)
print(json.dumps(dict(type='server-scan',counts=counts,extras=extras,errors=errors),ensure_ascii=False),flush=True)
hashes={{}}
for line in Path('/srv/data/donarium/inventory/library-sha256.ndjson').read_text().splitlines():
 row=json.loads(line);hashes[row['name']]=row
root=Path('/srv/data/google-drive/Идеально')
with ThreadPoolExecutor(max_workers=4) as executor:
 futures=[executor.submit(inventory.inspect_archive,p,root,hashes) for p in sorted(allfiles)]
 for i,future in enumerate(as_completed(futures),1):
  row=future.result();row['type']='archive'
  print(json.dumps(row,ensure_ascii=False),flush=True)
  if i%50==0:print(json.dumps(dict(checked=i,total=len(allfiles))),file=sys.stderr,flush=True)
'''
    with open(output / 'server-audit.ndjson', 'xb') as stream:
        child = subprocess.Popen(SSH + ['python3 -u -'], stdin=subprocess.PIPE, stdout=stream)
        child.communicate(source.encode())
        if child.returncode:
            raise RuntimeError(f'Server audit failed: {child.returncode}')
        stream.flush()
        os.fsync(stream.fileno())
    rows = [json.loads(line) for line in (output / 'server-audit.ndjson').read_text().splitlines()]
    archives = [row for row in rows if row['type'] == 'archive']
    summary = dict(serverScan=rows[0], archives=len(archives), members=sum(len(r['entries']) for r in archives),
                   unchangedInventory=sum(r['inventoryUnchanged'] for r in archives),
                   listingErrors=[dict(path=r['path'],error=r['error']) for r in archives if r['error']])
    (output / 'server-summary.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({k:v for k,v in summary.items() if k!='serverScan'},ensure_ascii=False),flush=True)
finally:
    subprocess.run(SSH + [f'rm -f -- {remote}/7z {remote}/7z.so {remote}/inventory.py; rm -rf -- {remote}/__pycache__; rmdir -- {remote}'], check=True)
