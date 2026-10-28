#!/usr/bin/env bash
# Run only after owner approval of the production switch and completed acceptance checks.
set -euo pipefail
[ "$(id -u)" = 0 ]
[ "${DONARIUM_STORAGE_APPROVED:-}" = donarium ] || { echo 'Set DONARIUM_STORAGE_APPROVED=donarium only after reviewing the switch report';exit 1; }
for name in library uploads work inventory; do
 [ "$(findmnt -n -o SOURCE -T /mnt/donarium/$name)" = "192.168.0.141:/$name" ]
done
[ "$(docker exec donarium-db-1 psql -U donarium -d donarium -Atc "SELECT count(*) FROM schema_migrations WHERE name='006_storage_registry.sql'")" = 1 ]
backup=/home/hpelitdesk/apps/Donarium/backups/donarium-unit-$(date -u +%Y%m%dT%H%M%SZ)
install -d -o hpelitdesk -g hpelitdesk -m 0700 "$backup"
if [ -f /etc/systemd/system/donarium.service ];then cp -a /etc/systemd/system/donarium.service "$backup/";fi
install -m 0644 /home/hpelitdesk/apps/Donarium/deploy/storage/donarium.service /etc/systemd/system/donarium.service
systemctl daemon-reload
systemctl enable donarium.service
bash "$(dirname "$0")/enable-storage-recovery.sh"
