#!/usr/bin/env python3
"""Owner-approved, access-only ACL for the NFS anonymous UID; never recursive."""
import os, stat, struct, json, base64, subprocess, time
paths=['/srv/data/google-drive/Идеально','/srv/data/donarium/uploads','/srv/data/donarium/work','/srv/data/donarium/inventory']
expected='76d90fb2-6d59-4fdb-8280-81154e6c93d9'
if os.getuid()!=1000:raise SystemExit('Run as storage owner UID 1000')
if subprocess.check_output(['findmnt','-n','-o','UUID','-T','/srv/data'],text=True).strip()!=expected:raise SystemExit('Wrong disk')
original={}
for path in paths:
 st=os.lstat(path)
 if not stat.S_ISDIR(st.st_mode) or st.st_uid!=1000 or os.path.realpath(path)!=path:raise SystemExit('Unexpected directory owner or path')
 try:acl=os.getxattr(path,'system.posix_acl_access')
 except OSError as error:
  if error.errno!=61:raise
  acl=None
 original[path]={'mode':stat.S_IMODE(st.st_mode),'acl':base64.b64encode(acl).decode() if acl else None}
backup='/srv/data/donarium/backups/docker-nfs-traverse-acl-'+str(time.time_ns())+'.json'
fd=os.open(backup,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
with os.fdopen(fd,'w') as out:json.dump(original,out,ensure_ascii=False,indent=2);out.flush();os.fsync(out.fileno())
changed=[]
try:
 for path,old in original.items():
  if old['acl']:
   raw=base64.b64decode(old['acl'])
   if len(raw)<4 or struct.unpack('<I',raw[:4])[0]!=2 or (len(raw)-4)%8:raise ValueError('Unknown ACL encoding')
   entries=[list(struct.unpack('<HHI',raw[i:i+8])) for i in range(4,len(raw),8)]
  else:
   mode=old['mode'];entries=[[1,(mode>>6)&7,0xffffffff],[4,(mode>>3)&7,0xffffffff],[32,mode&7,0xffffffff]]
  entries=[e for e in entries if not(e[0]==2 and e[2]==65534)]
  entries.append([2,1,65534])
  mask=next((e for e in entries if e[0]==16),None)
  if mask:mask[1]|=1
  else:entries.append([16,next(e[1] for e in entries if e[0]==4)|1,0xffffffff])
  entries.sort(key=lambda e:(e[0],e[2]))
  value=struct.pack('<I',2)+b''.join(struct.pack('<HHI',*entry) for entry in entries)
  changed.append(path);os.setxattr(path,'system.posix_acl_access',value)
  if stat.S_IMODE(os.stat(path).st_mode)&7 != old['mode']&7:raise ValueError('Other-user permissions changed')
 print(json.dumps({'backup':backup,'uid':65534,'permission':'--x','recursive':False,'paths':paths},ensure_ascii=False))
except BaseException:
 for path in changed:
  old=original[path]
  if old['acl']:os.setxattr(path,'system.posix_acl_access',base64.b64decode(old['acl']))
  else:
   try:os.removexattr(path,'system.posix_acl_access')
   except OSError as error:
    if error.errno!=61:raise
  os.chmod(path,old['mode'])
 raise
