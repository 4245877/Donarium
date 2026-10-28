#!/usr/bin/env python3
"""Read-only archive hashing. Each result is fsynced; restart resumes unchanged files."""
import os, json, hashlib, time, stat, fcntl, subprocess
root='/srv/data/google-drive/Идеально'
base='/srv/data/donarium/inventory'
out=base+'/library-sha256.ndjson'
expected='76d90fb2-6d59-4fdb-8280-81154e6c93d9'
if subprocess.check_output(['findmnt','-n','-o','UUID','--target',root],text=True).strip()!=expected:raise SystemExit('Wrong data disk')
if os.path.realpath(root)!=root or os.path.realpath(base)!=base or os.stat(root).st_dev!=os.stat(base).st_dev:raise SystemExit('Unsafe inventory filesystem')
lock=open(base+'/library-hash.lock','a')
try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
except BlockingIOError:raise SystemExit('Inventory is already running')
previous={}
if os.path.exists(out):
    with open(out) as stream:
        for line in stream:
            try:
                row=json.loads(line);previous[row['name']]=row
            except (ValueError,KeyError):pass
files=[]
for name in sorted(os.listdir(root)):
    if name.startswith('.'):continue
    st=os.lstat(os.path.join(root,name))
    if stat.S_ISREG(st.st_mode):files.append((name,st))
status={'total':len(files),'checked':0,'bytes':0,'total_bytes':sum(st.st_size for _,st in files),'complete':False,'started_at':time.time()}
def progress():
    status['updated_at']=time.time()
    with open(base+'/library-hash-status.json.tmp','w') as dest:
        json.dump(status,dest);dest.flush();os.fsync(dest.fileno())
    os.replace(base+'/library-hash-status.json.tmp',base+'/library-hash-status.json')
def fingerprint(st):return st.st_dev,st.st_ino,st.st_size,st.st_mtime_ns,st.st_ctime_ns
progress()
with open(out,'a',buffering=1) as journal:
    for name,st in files:
        path=os.path.join(root,name);old=previous.get(name,{})
        if not (old.get('size')==st.st_size and int(old.get('mtime_ns',-1))==st.st_mtime_ns and int(old.get('ctime_ns',-1))==st.st_ctime_ns):
            h=hashlib.sha256();fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
            with os.fdopen(fd,'rb') as source:
                if fingerprint(os.fstat(source.fileno()))!=fingerprint(st):raise SystemExit('Original changed: '+name)
                for chunk in iter(lambda:source.read(8*1024*1024),b''):h.update(chunk)
                if fingerprint(os.fstat(source.fileno()))!=fingerprint(st):raise SystemExit('Original changed: '+name)
            if fingerprint(os.lstat(path))!=fingerprint(st):raise SystemExit('Original replaced: '+name)
            row={'name':name,'size':st.st_size,'sha256':h.hexdigest(),'mtime_ns':str(st.st_mtime_ns),'ctime_ns':str(st.st_ctime_ns),'checked_at':time.time()}
            journal.write(json.dumps(row,ensure_ascii=False)+'\n');journal.flush();os.fsync(journal.fileno())
        status['checked']+=1;status['bytes']+=st.st_size;status['current']=name;progress()
status['complete']=True;progress();print('Inventory complete')
