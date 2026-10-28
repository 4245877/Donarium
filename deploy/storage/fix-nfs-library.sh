#!/usr/bin/env bash
# Run on .141 before production storage is switched. No archive is moved or rewritten.
set -euo pipefail
[ "$(id -u)" = 0 ]
/usr/local/sbin/donarium-disk-check
[ "$(findmnt -n -o TARGET -T /srv/data/donarium/library)" = /srv/data/donarium/library ]
[ "$(stat -c %i /srv/data/donarium/library)" = "$(stat -c %i /srv/data/google-drive/Идеально)" ]
backup=/srv/data/donarium/backups/nfs-bind-fix-$(date -u +%Y%m%dT%H%M%SZ)
install -d -m 0700 "$backup"
cp -a /etc/exports.d/donarium.exports "$backup/"
exportfs -v > "$backup/exports-before.txt"
# Explicit child exports keep their existing ro/rw options; only the library is a submount.
python3 - <<'PY'
import os
path='/etc/exports.d/donarium.exports'
text=open(path).read()
old='/srv/data/donarium 192.168.0.151(ro,fsid=0,sync,no_subtree_check,root_squash,sec=sys,mountpoint=/srv/data)'
new=old.replace('ro,fsid=0,','ro,fsid=0,crossmnt,')
if old not in text and new not in text:raise SystemExit('Unexpected exports; no change made')
text=text.replace(old,new)
with open(path+'.tmp','w') as out:out.write(text);out.flush();os.fsync(out.fileno())
os.chmod(path+'.tmp',0o644);os.replace(path+'.tmp',path)
PY
# Flush handles from the pre-bind export and restart only the newly installed NFS stack.
systemctl stop nfs-server.service
systemctl restart fsidd.service
systemctl start nfs-server.service
exportfs -ra
exportfs -f
exportfs -v
printf 'NFS library export refreshed. Backup: %s\n' "$backup"
