#!/usr/bin/env python3
"""Retry failed archive directory reads once, preserving the initial audit."""
import importlib.util
import json
import os
from pathlib import Path
import sys
import subprocess

base = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('inventory', base / 'figure-link-inventory.py')
inventory = importlib.util.module_from_spec(spec)
spec.loader.exec_module(inventory)
original_run = subprocess.run


def bounded_run(argv, **kwargs):
    kwargs['timeout'] = 120
    return original_run(argv, **kwargs)


inventory.subprocess.run = bounded_run
os.umask(0o077)
directory = Path(sys.argv[1])
path = directory / 'server-audit.ndjson'
rows = [json.loads(line) for line in path.read_text().splitlines()]
failed = [row for row in rows if row.get('type') == 'archive' and row['error']]
hashes = {row['path']: dict(name=row['path'], **row['fingerprint'], sha256=row['sha256'])
          for row in rows if row.get('type') == 'archive'}
replacements = {}
for row in failed:
    replacement = inventory.inspect_archive(Path('/mnt/donarium/library',row['path']),Path('/mnt/donarium/library'),hashes)
    replacement['type'] = 'archive'
    replacements[row['path']] = replacement
    print(json.dumps(dict(path=row['path'], passed=not replacement['error'], error=replacement['error'])),flush=True)
if failed:
    path.rename(directory / 'server-audit-initial.ndjson')
    rows = [replacements.get(row.get('path'), row) for row in rows]
    path.write_text(''.join(json.dumps(row,ensure_ascii=False)+'\n' for row in rows))
archives = [row for row in rows if row.get('type') == 'archive']
summary = dict(serverScan=rows[0], archives=len(archives), members=sum(len(r['entries']) for r in archives),
               unchangedInventory=sum(r['inventoryUnchanged'] for r in archives),
               listingErrors=[dict(path=r['path'],error=r['error']) for r in archives if r['error']],
               initialReadErrors=[dict(path=r['path'],error=r['error']) for r in failed],
               retried=len(failed), retryPassed=sum(not r['error'] for r in replacements.values()))
(directory / 'server-summary.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({k:v for k,v in summary.items() if k not in ['serverScan','initialReadErrors']},ensure_ascii=False),flush=True)
