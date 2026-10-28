#!/usr/bin/env python3
"""Convert verified journal timestamps to lossless decimal strings. No archive is read/written."""
import os,json,time,fcntl,stat
base='/srv/data/donarium/inventory'
lock=open(base+'/library-hash.lock','a');fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
path=base+'/library-sha256.ndjson';latest={}
with open(path) as source:
 for line in source:
  row=json.loads(line);latest[row['name']]=row
for name,row in latest.items():
 info=os.lstat('/srv/data/google-drive/Идеально/'+name)
 if not stat.S_ISREG(info.st_mode) or info.st_size!=row['size'] or info.st_mtime_ns!=int(row['mtime_ns']) or info.st_ctime_ns!=int(row['ctime_ns']):raise SystemExit('Original metadata changed; checksum not reused: '+name)
 row['mtime_ns']=str(row['mtime_ns']);row['ctime_ns']=str(row['ctime_ns'])
backup=base+'/library-sha256-legacy-'+str(time.time_ns())+'.ndjson'
os.link(path,backup)
fd=os.open(path+'.next',os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
with os.fdopen(fd,'w') as out:
 for row in latest.values():out.write(json.dumps(row,ensure_ascii=False)+'\n')
 out.flush();os.fsync(out.fileno())
os.replace(path+'.next',path)
print(json.dumps({'records':len(latest),'timestamps':'lossless decimal strings','backup':backup}))
