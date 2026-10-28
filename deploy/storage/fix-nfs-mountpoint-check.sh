#!/usr/bin/env bash
# .141: nfs-utils' legacy stat-based mountpoint test misses same-device bind mounts.
set -euo pipefail
[ "$(id -u)" = 0 ]
/usr/local/sbin/donarium-disk-check
for name in library uploads work inventory;do
 [ "$(stat -c %d:%i /srv/data/donarium/.exports/$name)" = "$(stat -c %d:%i /srv/data/donarium/$name)" ]
done
backup=/srv/data/donarium/backups/nfs-mountpoint-check-$(date -u +%Y%m%dT%H%M%SZ)
install -d -m 0700 "$backup"
cp -a /etc/exports.d/donarium.exports "$backup/"
cat /proc/fs/nfsd/exports > "$backup/kernel-exports-before.txt"
python3 - <<'PY'
import os
path='/etc/exports.d/donarium.exports'
lines=open(path).readlines();count=0
for i,line in enumerate(lines):
 if line.startswith('/srv/data/donarium/.exports/'):
  count+=1
  if ',mountpoint)' in line:lines[i]=line.replace(',mountpoint)',',mountpoint=/srv/data)')
  elif ',mountpoint=/srv/data)' not in line:raise SystemExit('Unexpected child export; no change made')
if count!=4:raise SystemExit('Expected four project child exports; no change made')
with open(path+'.tmp','w') as out:out.writelines(lines);out.flush();os.fsync(out.fileno())
os.chmod(path+'.tmp',0o644);os.replace(path+'.tmp',path)
PY
# UUID and bind-mount checks remain in systemd's mandatory ExecStartPre guard.
exportfs -rav
exportfs -f
printf 'NFS export guard corrected. Backup: %s\n' "$backup"
