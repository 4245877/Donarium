#!/usr/bin/env python3
"""Verify every original/card/attachment against the pre-maintenance snapshot."""
import argparse
import json
from pathlib import Path
import subprocess

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('directory', type=Path)
parser.add_argument('backup', type=Path)
args = parser.parse_args()
directory = args.directory
before = json.loads((args.backup / 'before.json').read_text())
after = json.loads((directory / 'after.json').read_text())
plan = json.loads((directory / 'plan.json').read_text())
expected = [p for p in plan['products'] if p['status'] == 'ready']
for table, fingerprint in before['fingerprints'].items():
    if table not in ['assets', 'storage_files', 'storage_events', 'storage_operations']:
        assert after['fingerprints'][table] == fingerprint, f'Unexpected changes to {table}'
original_assets = {a['id']: a for a in before['data']['assets']}
current_assets = {a['id']: a for a in after['data']['assets']}
for asset_id, asset in original_assets.items():
    assert current_assets.get(asset_id) == asset, f'Old attachment changed: {asset_id}'
figures = [a for a in current_assets.values() if a['metadata'].get('role') == 'figure' and not a['retired_at']]
assert len(figures) == len(expected)
assert len({a['product_id'] for a in figures}) == len(figures)
assert len({(a['product_id'], a['file_id']) for a in current_assets.values() if a['file_id']}) == sum(bool(a['file_id']) for a in current_assets.values())
by_product = {a['product_id']: a for a in figures}
locations = {s['id']: s['key'] for s in before['data']['storage_locations']}
files = {f['id']: f for f in after['data']['storage_files']}
changed = {p['fileId'] for p in expected}
for p in expected:
    a = by_product[p['productId']]
    assert a['file_id'] == p['fileId']
    assert a['relative_path'] == p['path'] == files[p['fileId']]['relative_path']
    assert locations[a['storage_id']] == p['root']
    assert files[p['fileId']]['status'] == 'available'
for file in before['data']['storage_files']:
    current = files[file['id']]
    if file['id'] in changed:
        assert {k:v for k,v in file.items() if k not in ['checked_at','metadata']} == {k:v for k,v in current.items() if k not in ['checked_at','metadata']}
    else:
        assert current == file
assert len(current_assets) == len(original_assets) + len(expected)
assert len(files) == len(before['data']['storage_files'])
audit = [json.loads(line) for line in (directory / 'server-audit.ndjson').read_text().splitlines()]
fingerprints = {row['path']: row['fingerprint'] for row in audit if row.get('type') == 'archive'}
source = 'expected = ' + repr(fingerprints) + '''
import os,json,stat
root='/srv/data/google-drive/Идеально'
actual=set();issues=[]
for directory,dirs,names in os.walk(root,followlinks=False):
 for name in names:
  if name=='.donarium-volume':continue
  path=os.path.join(directory,name);relative=os.path.relpath(path,root);actual.add(relative)
  s=os.lstat(path)
  f=dict(size=s.st_size,mtime_ns=str(s.st_mtime_ns),ctime_ns=str(s.st_ctime_ns),inode=s.st_ino)
  if not stat.S_ISREG(s.st_mode) or expected.get(relative)!=f:issues.append(relative)
missing=sorted(set(expected)-actual)
print(json.dumps(dict(passed=not issues and not missing,checked=len(actual),expected=len(expected),changedOrAdded=issues,missing=missing)))
'''
result = subprocess.run(['ssh','-o','BatchMode=yes','-o','ConnectTimeout=5','miha@192.168.0.141','python3 -'],
                        input=source.encode(),capture_output=True,check=True)
originals = json.loads(result.stdout)
assert originals['passed'], 'Original library changed during maintenance'
(directory / 'originals-verification.json').write_text(json.dumps(originals,indent=2)+'\n')
summary = dict(passed=True, productsUnchanged=len(before['data']['products']),
               oldAttachmentsUnchanged=len(original_assets), registryFiles=len(files),
               newFigureAttachments=len(figures), uniqueFigures=True,
               otherTablesUnchanged=True, originalLibrary=originals,
               originalFilesCopied=0, originalFilesMoved=0, originalFilesRenamed=0, originalFilesDeleted=0)
(directory / 'preservation.json').write_text(json.dumps(summary,indent=2)+'\n')
print(json.dumps(summary))
