#!/usr/bin/env bash
# Prepare NFS mounts on .151. Does not change .env, compose or running containers.
set -euo pipefail
[ "$(id -u)" = 0 ]
ip -4 route get 192.168.0.141 | grep -q 'src 192.168.0.151'
[ "$(id -u hpelitdesk):$(id -g hpelitdesk)" = 1000:1000 ]
backup=/home/hpelitdesk/apps/Donarium/backups/nfs-client-$(date -u +%Y%m%dT%H%M%SZ)
install -d -o hpelitdesk -g hpelitdesk -m 0700 "$backup"
for name in library uploads work inventory; do
  path=/mnt/donarium/$name
  if ! mountpoint -q "$path"; then
    if [ -d "$path" ] && [ -n "$(find "$path" -mindepth 1 -maxdepth 1 -print -quit)" ]; then echo "Nonempty mount point: $path";exit 1;fi
    install -d -o root -g root -m 000 "$path"
  fi
  file=/etc/systemd/system/mnt-donarium-$name.mount
  if [ -e "$file" ]; then cp -a "$file" "$backup/";fi
done
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y nfs-common
for name in library uploads work inventory; do
  access=ro
  if [ "$name" = uploads ] || [ "$name" = work ]; then access=rw;fi
  cat > "/etc/systemd/system/mnt-donarium-$name.mount" <<UNIT
[Unit]
Description=Donarium $name on verified storage server
Wants=network-online.target
After=network-online.target
[Mount]
What=192.168.0.141:/$name
Where=/mnt/donarium/$name
Type=nfs4
Options=$access,vers=4.2,proto=tcp,hard,timeo=600,retrans=2,_netdev,nosuid,nodev,noexec
TimeoutSec=90
[Install]
WantedBy=remote-fs.target
UNIT
done
systemctl daemon-reload
for name in library uploads work inventory; do systemctl enable --now "mnt-donarium-$name.mount"; done
for name in library uploads work inventory; do
  [ "$(findmnt -n -o SOURCE -T /mnt/donarium/$name)" = "192.168.0.141:/$name" ]
  runuser -u hpelitdesk -- cat "/mnt/donarium/$name/.donarium-volume"
done
# Only synthetic files in uploads; never test writes against the original library.
runuser -u hpelitdesk -- python3 - <<'PY'
import os,uuid
path='/mnt/donarium/uploads/.nfs-probe-'+str(uuid.uuid4())
fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
try: os.write(fd,b'Donarium NFS probe');os.fsync(fd)
finally: os.close(fd)
assert open(path,'rb').read()==b'Donarium NFS probe'
os.unlink(path)
PY
printf 'NFS prepared. Production containers and storage configuration are unchanged. Backup: %s\n' "$backup"
