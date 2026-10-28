#!/usr/bin/env bash
# .141 only. Dedicated NFSv4 pseudoroot with real bind mount children.
# No archive/upload is copied, renamed, rewritten or removed.
set -euo pipefail
[ "$(id -u)" = 0 ]
[ "$(hostname)" = thinkcentre715q ]
[ "$(findmnt -n -o TARGET -T /srv/data)" = /srv/data ]
[ "$(findmnt -n -o UUID -T /srv/data)" = 76d90fb2-6d59-4fdb-8280-81154e6c93d9 ]
[ "$(stat -c %i /srv/data/donarium/library)" = "$(stat -c %i /srv/data/google-drive/Идеально)" ]
backup=/srv/data/donarium/backups/nfs-exports-$(date -u +%Y%m%dT%H%M%SZ)
install -d -m 0700 "$backup"
cp -a /etc/exports.d/donarium.exports "$backup/"
cp -a /etc/systemd/system/nfs-server.service.d "$backup/"
cp -a /usr/local/sbin/donarium-disk-check "$backup/"
exportfs -v > "$backup/exports-before.txt"
# Actual parent directories retain all existing data and permissions. Bind targets are empty.
install -d -o root -g root -m 0711 /srv/data/donarium/.exports
units=()
for name in library uploads work inventory;do
  source=/srv/data/donarium/$name
  target=/srv/data/donarium/.exports/$name
  if ! mountpoint -q "$target";then
    if [ -d "$target" ] && [ -n "$(find "$target" -mindepth 1 -maxdepth 1 -print -quit)" ];then echo "Nonempty target $target";exit 1;fi
    install -d -o root -g root -m 000 "$target"
  fi
  unit=$(systemd-escape --path --suffix=mount "$target")
  units+=("$unit")
  options=bind
  if [ "$name" = library ];then options=bind,ro;fi
  file=/etc/systemd/system/$unit
  if [ -e "$file" ];then cp -a "$file" "$backup/";fi
  cat > "$file" <<UNIT
[Unit]
Description=Donarium NFS $name view
RequiresMountsFor=$source
BindsTo=srv-data.mount
After=srv-data.mount
Before=nfs-server.service
[Mount]
What=$source
Where=$target
Type=none
Options=$options
[Install]
WantedBy=multi-user.target
UNIT
done
cat > /usr/local/sbin/donarium-disk-check <<'CHECK'
#!/bin/sh
set -eu
[ "$(findmnt -n -o TARGET -T /srv/data)" = /srv/data ]
[ "$(findmnt -n -o UUID -T /srv/data)" = 76d90fb2-6d59-4fdb-8280-81154e6c93d9 ]
for name in library uploads work inventory;do
 path=/srv/data/donarium/.exports/$name
 [ "$(findmnt -n -o TARGET -T "$path")" = "$path" ]
 [ "$(findmnt -n -o UUID -T "$path")" = 76d90fb2-6d59-4fdb-8280-81154e6c93d9 ]
done
CHECK
chmod 0755 /usr/local/sbin/donarium-disk-check
cat > /etc/systemd/system/nfs-server.service.d/donarium.conf <<UNIT
[Unit]
Requires=srv-data-donarium-library.mount donarium-nfs-guard.service ${units[*]}
RequiresMountsFor=/srv/data
BindsTo=srv-data.mount ${units[*]}
After=srv-data.mount srv-data-donarium-library.mount donarium-nfs-guard.service ${units[*]}
[Service]
ExecStartPre=/usr/local/sbin/donarium-disk-check
UNIT
# Only the four actual bind children are exported. No project backups/quarantine are exposed.
cat > /etc/exports.d/donarium.exports <<'EXPORTS'
/srv/data/donarium/.exports 192.168.0.151(ro,fsid=0,crossmnt,sync,no_subtree_check,root_squash,sec=sys,mountpoint=/srv/data)
/srv/data/donarium/.exports/library 192.168.0.151(ro,fsid=101,sync,no_subtree_check,root_squash,sec=sys,mountpoint=/srv/data)
/srv/data/donarium/.exports/uploads 192.168.0.151(rw,fsid=102,sync,no_subtree_check,root_squash,sec=sys,mountpoint=/srv/data)
/srv/data/donarium/.exports/work 192.168.0.151(rw,fsid=103,sync,no_subtree_check,root_squash,sec=sys,mountpoint=/srv/data)
/srv/data/donarium/.exports/inventory 192.168.0.151(ro,fsid=104,sync,no_subtree_check,root_squash,sec=sys,mountpoint=/srv/data)
EXPORTS
systemctl daemon-reload
for unit in "${units[@]}";do systemctl enable --now "$unit";done
/usr/local/sbin/donarium-disk-check
systemctl stop nfs-server.service
systemctl restart fsidd.service
systemctl start nfs-server.service
exportfs -ra
exportfs -f
findmnt -t ext4 -o TARGET,SOURCE,OPTIONS | grep /srv/data
exportfs -v
printf 'NFS pseudoroot ready. Config backup: %s\n' "$backup"
