#!/usr/bin/env bash
# Run on .141 with sudo. Does not rename or alter original archives.
set -euo pipefail
[ "$(id -u)" = 0 ]
[ "$(hostname)" = thinkcentre715q ]
[ "$(id -u miha):$(id -g miha)" = 1000:1000 ]
[ "$(findmnt -n -o UUID --target /srv/data)" = 76d90fb2-6d59-4fdb-8280-81154e6c93d9 ]
[ "$(findmnt -n -o TARGET --target /srv/data)" = /srv/data ]
[ -d /srv/data/google-drive/Идеально ]
backup=/srv/data/donarium/backups/nfs-config-$(date -u +%Y%m%dT%H%M%SZ)
install -d -o miha -g miha -m 0711 /srv/data/donarium
for name in library uploads work inventory quarantine backups; do
  if [ "$name" = library ] && mountpoint -q /srv/data/donarium/library; then continue;fi
  install -d -o miha -g miha -m 0750 "/srv/data/donarium/$name"
done
install -d -m 0700 "$backup"
for path in /etc/exports /etc/exports.d /etc/nfs.conf.d /etc/systemd/system/nfs-server.service.d; do
  if [ -e "$path" ]; then cp -a --parents "$path" "$backup/"; fi
done
# No existing NFS deployment was found during preflight. Do not silently replace one.
if [ -f /etc/exports ] && sed '/^[[:space:]]*#/d;/^[[:space:]]*$/d' /etc/exports | read -r _; then echo 'Existing exports require review'; exit 1; fi
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y nfs-kernel-server nftables
install -d /etc/exports.d /etc/nfs.conf.d /etc/systemd/system/nfs-server.service.d
cat > /usr/local/sbin/donarium-disk-check <<'CHECK'
#!/bin/sh
set -eu
[ "$(findmnt -n -o TARGET --target /srv/data)" = /srv/data ]
[ "$(findmnt -n -o UUID --target /srv/data)" = 76d90fb2-6d59-4fdb-8280-81154e6c93d9 ]
CHECK
chmod 0755 /usr/local/sbin/donarium-disk-check
cat > /etc/systemd/system/srv-data-donarium-library.mount <<'UNIT'
[Unit]
Description=Read-only Donarium library view (original names and bytes retained)
RequiresMountsFor=/srv/data/google-drive/Идеально
BindsTo=srv-data.mount
After=srv-data.mount
Before=nfs-server.service
[Mount]
What=/srv/data/google-drive/Идеально
Where=/srv/data/donarium/library
Type=none
Options=bind,ro
[Install]
WantedBy=multi-user.target
UNIT
cat > /etc/systemd/system/nfs-server.service.d/donarium.conf <<'UNIT'
[Unit]
Requires=srv-data-donarium-library.mount donarium-nfs-guard.service
RequiresMountsFor=/srv/data
BindsTo=srv-data.mount
After=srv-data.mount srv-data-donarium-library.mount donarium-nfs-guard.service
[Service]
ExecStartPre=/usr/local/sbin/donarium-disk-check
UNIT
cat > /etc/nfs.conf.d/donarium.conf <<'CONF'
[nfsd]
vers2=n
vers3=n
vers4=y
udp=n
tcp=y
CONF
cat > /etc/exports.d/donarium.exports <<'EXPORTS'
/srv/data/donarium 192.168.0.151(ro,fsid=0,sync,no_subtree_check,root_squash,sec=sys,mountpoint=/srv/data)
/srv/data/donarium/library 192.168.0.151(ro,fsid=101,sync,no_subtree_check,root_squash,sec=sys,mountpoint=/srv/data)
/srv/data/donarium/uploads 192.168.0.151(rw,fsid=102,sync,no_subtree_check,root_squash,sec=sys,mountpoint=/srv/data)
/srv/data/donarium/work 192.168.0.151(rw,fsid=103,sync,no_subtree_check,root_squash,sec=sys,mountpoint=/srv/data)
/srv/data/donarium/inventory 192.168.0.151(ro,fsid=104,sync,no_subtree_check,root_squash,sec=sys,mountpoint=/srv/data)
EXPORTS
# Limit only NFS's port. Existing SSH, firewall tables and other applications are untouched.
cat > /usr/local/sbin/donarium-nfs-guard <<'GUARD'
#!/bin/sh
set -eu
if nft list table inet donarium_nfs >/dev/null 2>&1; then exit 0; fi
nft -f - <<'NFT'
table inet donarium_nfs {
 chain input {
  type filter hook input priority -10; policy accept;
  ip saddr 192.168.0.151 tcp dport 2049 accept
  tcp dport 2049 drop
  udp dport 2049 drop
 }
}
NFT
GUARD
chmod 0755 /usr/local/sbin/donarium-nfs-guard
cat > /etc/systemd/system/donarium-nfs-guard.service <<'UNIT'
[Unit]
Description=Restrict Donarium NFS to application server
After=nftables.service
Before=nfs-server.service
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/sbin/donarium-nfs-guard
[Install]
WantedBy=multi-user.target
UNIT
# Stable disk identity markers; not secrets. The original library remains unmodified.
for name in uploads work inventory; do
  printf '%s\n' "donarium:76d90fb2-6d59-4fdb-8280-81154e6c93d9:$name" > "/srv/data/donarium/$name/.donarium-volume"
  chown miha:miha "/srv/data/donarium/$name/.donarium-volume"
  chmod 0440 "/srv/data/donarium/$name/.donarium-volume"
done
printf '%s\n' 'donarium:76d90fb2-6d59-4fdb-8280-81154e6c93d9:library' > /srv/data/google-drive/Идеально/.donarium-volume
chown miha:miha /srv/data/google-drive/Идеально/.donarium-volume
chmod 0440 /srv/data/google-drive/Идеально/.donarium-volume
systemctl daemon-reload
systemctl enable --now donarium-nfs-guard.service srv-data-donarium-library.mount
/usr/local/sbin/donarium-disk-check
if command -v ufw >/dev/null && LC_ALL=C ufw status | grep -q '^Status: active'; then
  ufw allow from 192.168.0.151 to any port 2049 proto tcp comment 'Donarium NFSv4'
fi
systemctl enable nfs-server.service
systemctl restart nfs-server.service
exportfs -ra
findmnt -T /srv/data/donarium/library
exportfs -v
printf 'Server preparation complete. Config backup: %s\n' "$backup"

# Final NFSv4 views avoid inheriting a parent ro export for writable child directories.
bash "$(dirname "$0")/configure-nfs-exports.sh"

# Approved address-only traversal ACL, preserving root_squash and all other-user bits.
runuser -u miha -- python3 "$(dirname "$0")/allow-docker-nfs-traverse.py"
