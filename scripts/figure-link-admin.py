#!/usr/bin/env python3
"""Snapshot and verify a database backup before figure-link maintenance.

Uses the existing containers; never puts credentials in arguments or output.
Only a uniquely named temporary verification database is created/dropped.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time

BASE = Path(__file__).resolve().parent.parent


def run(argv, **kwargs):
    return subprocess.run(argv, check=True, capture_output=True, **kwargs).stdout


def snapshot(database=None, fingerprints_only=False):
    arguments = json.dumps(dict(database=database, fingerprintsOnly=fingerprints_only))
    source = (BASE / 'scripts/figure-link-db.mjs').read_bytes()
    return json.loads(run(['docker', 'exec', '-i', '-e', f'FIGURE_LINK_ARGUMENTS={arguments}',
                           'donarium-app-1', 'node', '--input-type=module'], input=source))


def save(path, data):
    with open(path, 'x', encoding='utf-8') as stream:
        json.dump(data, stream, ensure_ascii=False, indent=2)
        stream.write('\n')
        stream.flush()
        os.fsync(stream.fileno())


def backup(destination):
    destination.mkdir(mode=0o700, parents=True, exist_ok=False)
    before = snapshot()
    save(destination / 'before.json', before)
    dump = destination / 'database.dump'
    with open(dump, 'xb') as stream:
        subprocess.run(['docker', 'exec', 'donarium-db-1', 'pg_dump', '-U', 'donarium', '-d', 'donarium',
                        '--format=custom', '--no-owner', '--no-acl'], stdout=stream, check=True)
        stream.flush()
        os.fsync(stream.fileno())
    after = snapshot(fingerprints_only=True)
    assert before['fingerprints'] == after['fingerprints'], 'Production changed during backup; repeat backup'
    database = f'donarium_autolink_verify_{time.time_ns()}'
    run(['docker', 'exec', 'donarium-db-1', 'createdb', '-U', 'donarium', database])
    try:
        with open(dump, 'rb') as stream:
            subprocess.run(['docker', 'exec', '-i', 'donarium-db-1', 'pg_restore', '-U', 'donarium',
                            '-d', database, '--no-owner', '--no-acl', '--exit-on-error'], stdin=stream, check=True)
        restored = snapshot(database, fingerprints_only=True)
        assert restored['fingerprints'] == before['fingerprints'], 'Restored database differs'
        save(destination / 'backup-verified.json', dict(
            result='passed', verifiedAt=time.time(), database='donarium',
            dumpBytes=dump.stat().st_size, sha256=hashlib.sha256(dump.read_bytes()).hexdigest(),
            restoredDatabase=database, tables=restored['fingerprints'], productionStableDuringBackup=True))
    finally:
        run(['docker', 'exec', 'donarium-db-1', 'dropdb', '-U', 'donarium', database])
    print(json.dumps(dict(backup=str(destination), verified=True,
                          tables=len(before['fingerprints']), products=len(before['data']['products']))))


if __name__ == '__main__':
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['backup', 'snapshot'])
    parser.add_argument('destination', type=Path)
    arguments = parser.parse_args()
    if arguments.action == 'backup':
        backup(arguments.destination)
    else:
        save(arguments.destination, snapshot())
