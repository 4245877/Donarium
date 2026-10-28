#!/usr/bin/env python3
"""Read archive directories only. No extraction or writes to source storage.

Retains member names, sizes, CRC and split/encryption information to distinguish
figure packages. Existing full-file hashes are accepted only for unchanged stats.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import json
import os
from pathlib import Path
import stat
import subprocess
import time


def fingerprint(path):
    s = os.lstat(path)
    assert stat.S_ISREG(s.st_mode), f'Not a regular file: {path}'
    return dict(size=s.st_size, mtime_ns=str(s.st_mtime_ns), ctime_ns=str(s.st_ctime_ns), inode=s.st_ino)


def inspect_archive(path, root, hashes):
    before = fingerprint(path)
    relative = str(path.relative_to(root))
    row = dict(path=relative, fingerprint=before, entries=[], error=None)
    old = hashes.get(relative, {})
    row['inventoryUnchanged'] = all(str(old.get(k)) == str(before[k]) for k in ['size', 'mtime_ns', 'ctime_ns'])
    row['sha256'] = old.get('sha256') if row['inventoryUnchanged'] else None
    try:
        result = subprocess.run(['7z', 'l', '-slt', '-ba', '-sccUTF-8', '-pDONARIUM_NO_PASSWORD', '--', str(path)],
                                stdin=subprocess.DEVNULL, capture_output=True, timeout=45)
        text = result.stdout.decode('utf-8', errors='replace')
        row['exitCode'] = result.returncode
        if result.returncode:
            row['error'] = result.stderr.decode('utf-8', errors='replace').strip()[-2000:]
        for block in text.replace('\r\n', '\n').split('\n\n'):
            data = dict(line.split(' = ', 1) for line in block.splitlines() if ' = ' in line)
            if 'Path' in data:
                row['entries'].append({k: data[k] for k in ['Path', 'Size', 'CRC', 'Folder', 'Encrypted',
                                                          'Split Before', 'Split After', 'Symbolic Link',
                                                          'Hard Link', 'Volume Index'] if data.get(k)})
        if not row['entries']:
            row['error'] = row['error'] or 'Empty or unreadable archive directory'
        if any(e.get('Encrypted') == '+' for e in row['entries']):
            row['error'] = row['error'] or 'Encrypted members require manual verification'
        if fingerprint(path) != before:
            row['error'] = 'Original changed while listing'
    except (OSError, subprocess.TimeoutExpired) as error:
        row['error'] = str(error)
    return row


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('destination', type=Path)
    parser.add_argument('--root', type=Path, default=Path('/mnt/donarium/library'))
    parser.add_argument('--hashes', type=Path, default=Path('/mnt/donarium/inventory/library-sha256.ndjson'))
    args = parser.parse_args()
    os.umask(0o077)
    args.destination.mkdir(parents=True, exist_ok=True, mode=0o700)
    hashes = {}
    for line in args.hashes.read_text().splitlines():
        row = json.loads(line)
        hashes[row.get('name', row.get('path'))] = row
    paths = []
    errors = []
    other = []
    for directory, dirs, files in os.walk(args.root, followlinks=False, onerror=lambda e: errors.append(str(e))):
        dirs[:] = [d for d in dirs if not Path(directory, d).is_symlink()]
        for name in files:
            path = Path(directory, name)
            if name == '.donarium-volume':
                continue
            if path.suffix.lower() in ['.zip', '.rar', '.7z', '.gz', '.tar']:
                paths.append(path)
            else:
                other.append(dict(path=str(path.relative_to(args.root)), fingerprint=fingerprint(path)))
    start = time.time()
    rows = []
    with open(args.destination / 'archives.ndjson', 'x', encoding='utf-8') as output:
        with ThreadPoolExecutor(max_workers=4) as executor:
            futures = {executor.submit(inspect_archive, path, args.root, hashes): path for path in sorted(paths)}
            for future in as_completed(futures):
                row = future.result()
                rows.append(row)
                output.write(json.dumps(row, ensure_ascii=False) + '\n')
                output.flush()
                if len(rows) % 50 == 0:
                    print(json.dumps(dict(checked=len(rows), total=len(paths), errors=sum(bool(r['error']) for r in rows))), flush=True)
        os.fsync(output.fileno())
    summary = dict(root=str(args.root), archives=len(rows), members=sum(len(r['entries']) for r in rows),
                   listingErrors=[dict(path=r['path'], error=r['error']) for r in rows if r['error']],
                   unchangedInventory=sum(r['inventoryUnchanged'] for r in rows), otherFiles=other,
                   scanErrors=errors, seconds=round(time.time()-start, 1))
    (args.destination / 'inventory-summary.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(summary, ensure_ascii=False), flush=True)
