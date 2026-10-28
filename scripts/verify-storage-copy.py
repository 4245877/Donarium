#!/usr/bin/env python3
"""Verify a copied upload manifest on the data HDD; never changes originals."""
import os,json,hashlib,subprocess,sys,time
root='/srv/data/donarium/uploads'
if subprocess.check_output(['findmnt','-n','-o','UUID','--target',root],text=True).strip()!='76d90fb2-6d59-4fdb-8280-81154e6c93d9':raise SystemExit('Wrong data disk')
with open(sys.argv[1]) as source: files=json.load(source)
checked=0
for f in files:
    rel=f['relative_path']
    if not rel or os.path.isabs(rel) or '\\' in rel or any(p in ('','..','.') for p in rel.split('/')): raise SystemExit('Unsafe path')
    path=os.path.join(root,rel)
    current=root
    for part in rel.split('/'):
        current=os.path.join(current,part)
        if os.path.islink(current):raise SystemExit('Symlink')
    st=os.stat(path)
    if str(st.st_size)!=f['size_bytes']:raise SystemExit('Size mismatch '+f['id'])
    h=hashlib.sha256()
    with open(path,'rb') as stream:
        for chunk in iter(lambda:stream.read(1024*1024),b''):h.update(chunk)
    if h.hexdigest()!=f['sha256']:raise SystemExit('Checksum mismatch '+f['id'])
    checked+=1
report={'checked':checked,'errors':0,'disk_uuid':'76d90fb2-6d59-4fdb-8280-81154e6c93d9','completed_at':time.time()}
with open('/srv/data/donarium/inventory/uploads-copy-verification.json','w') as destination:json.dump(report,destination,indent=2)
print(json.dumps(report))
