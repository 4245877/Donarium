#!/usr/bin/env bash
# .151 only: retry failed NFS dependencies without relaxing any storage guard.
set -euo pipefail
[ "$(id -u)" = 0 ]
[ "$(id -u hpelitdesk):$(id -g hpelitdesk)" = 1000:1000 ]
[ "$(docker exec donarium-db-1 psql -U donarium -d donarium -Atc "SELECT count(*) FROM schema_migrations WHERE name='006_storage_registry.sql'")" = 1 ]
systemctl is-enabled --quiet donarium.service
source_dir=$(cd -- "$(dirname -- "$0")" && pwd)
backup=/home/hpelitdesk/apps/Donarium/backups/storage-boot-recovery-$(date -u +%Y%m%dT%H%M%SZ)
install -d -o hpelitdesk -g hpelitdesk -m 0700 "$backup"
for unit in donarium.service donarium-storage-recover.service; do
  file=/etc/systemd/system/$unit
  if [ -f "$file" ]; then cp -a "$file" "$backup/"; fi
done
for name in library uploads work inventory; do
  unit=mnt-donarium-$name.mount
  [ -f "/etc/systemd/system/$unit" ]
  cp -a "/etc/systemd/system/$unit" "$backup/"
  if [ -d "/etc/systemd/system/$unit.d" ]; then cp -a "/etc/systemd/system/$unit.d" "$backup/"; fi
done
install -m 0644 "$source_dir/donarium.service" /etc/systemd/system/donarium.service
install -m 0644 "$source_dir/donarium-storage-recover.service" /etc/systemd/system/donarium-storage-recover.service
for name in library uploads work inventory; do
  directory=/etc/systemd/system/mnt-donarium-$name.mount.d
  install -d -m 0755 "$directory"
  cat > "$directory/donarium-recovery.conf" <<'UNIT'
[Unit]
OnFailure=donarium-storage-recover.service
UNIT
done
systemctl daemon-reload
systemd-analyze verify /etc/systemd/system/donarium-storage-recover.service /etc/systemd/system/donarium.service
# The recovery unit retries only failed starts; a normal manual app stop does not trigger it.
systemctl reset-failed mnt-donarium-library.mount mnt-donarium-uploads.mount mnt-donarium-work.mount mnt-donarium-inventory.mount donarium-storage-recover.service || true
systemctl start --no-block donarium-storage-recover.service
printf 'Storage recovery installed; startup queued. Config backup: %s\n' "$backup"
