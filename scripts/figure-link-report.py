#!/usr/bin/env python3
"""Generate the actual execution report and per-product manual-review files."""
import argparse
from collections import Counter
import csv
import json
import os
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('directory', type=Path)
parser.add_argument('backup', type=Path)
args = parser.parse_args()
os.umask(0o077)
directory = args.directory
load = lambda name: json.loads((directory / name).read_text())
plan = load('plan.json')
applied = load('apply.json')
repeat = load('repeat.json')
verification = load('http-browser-verification.json')
preservation = load('preservation.json')
inventory = load('server-summary.json')
rollback = load('rollback-verification.json')
backup = json.loads((args.backup / 'backup-verified.json').read_text())
assert all(r.get('passed') for r in [applied, repeat, verification, preservation, rollback])
assert applied['attached'] == plan['counts']['ready']
assert verification['apiProducts'] == len(plan['products'])
assert verification['byteRangeDownloads'] == applied['attached']
assert repeat['attached'] == 0 and repeat['databaseUnchanged']
snapshot = json.loads((args.backup / 'before.json').read_text())['data']
files = {f['id']: f['relative_path'] for f in snapshot['storage_files']}
rows = plan['products']
manual = [p for p in rows if p['status'] not in ['ready', 'already_correct']]
statuses = {'ready': 'Привязан', 'already_correct': 'Уже имел правильную привязку',
            'manual': 'Требуется ручная проверка', 'ambiguous': 'Несколько кандидатов',
            'missing': 'Нет точного соответствия'}


def display_source(product):
    values = list(dict.fromkeys(s['name'] for s in product['sources']))
    if values and all(v.casefold() in ['google диск', 'google drive', 'google-диск'] for v in values):
        return 'Не указано (название внешнего вложения: ' + '; '.join(values) + ')'
    return '; '.join(values) or 'отсутствует'


fieldnames = ['id', 'Название карточки', 'Статус', 'Исходное имя', 'Возможные файлы', 'Причина', 'Совпавшие признаки внутри архива']
for filename, records in [('manual-review.csv', manual), ('all-decisions.csv', rows)]:
    with open(directory / filename, 'w', encoding='utf-8-sig', newline='') as stream:
        writer = csv.writer(stream)
        writer.writerow(fieldnames)
        for p in sorted(records, key=lambda row: row['title'].casefold()):
            candidates = [files[f] for f in p['candidates']]
            candidates += [s['path'] + ' (только поисковая подсказка)' for s in p.get('suggestions', [])]
            writer.writerow([p['productId'], p['title'], statuses[p['status']], display_source(p),
                             ' | '.join(dict.fromkeys(candidates)), '; '.join(p['reasons']),
                             ', '.join(p.get('evidence', {}).get('memberIdentityMatches', []))])
lines = ['# Карточки для ручной проверки', '',
         'Файлы ниже не привязаны. Нечёткие подсказки не считаются подтверждёнными кандидатами.', '']
for p in sorted(manual, key=lambda row: row['title'].casefold()):
    lines += [f"## {p['title']}", '', f"Карточка: `{p['productId']}`", '',
              'Исходное имя: ' + display_source(p), '',
              'Причина: ' + '; '.join(p['reasons']), '', 'Возможные файлы:', '']
    candidates = [files[f] for f in p['candidates']]
    if candidates:
        lines += ['- `' + candidate + '`' for candidate in dict.fromkeys(candidates)]
    else:
        lines += ['- Точного кандидата нет.']
    if p.get('suggestions'):
        lines += ['', 'Поисковые подсказки, требующие проверки персонажа, автора и версии:', '']
        lines += ['- `' + s['path'] + '`' for s in p['suggestions']]
    lines += ['']
(directory / 'manual-review.md').write_text('\n'.join(lines))
counts = Counter(p['status'] for p in rows)
summary = dict(
    passed=True, productsAnalyzed=len(rows), modelArchives=inventory['archives'], archiveMembers=inventory['members'],
    modelArchiveBytes=0,
    newlyLinked=applied['attached'], alreadyCorrectBefore=counts['already_correct'],
    noExactFile=counts['missing'], manualReview=counts['manual'] + counts['ambiguous'],
    totalUnlinked=len(manual), operationId=applied['operationId'],
    verifiedApiProducts=verification['apiProducts'], verifiedDownloads=verification['byteRangeDownloads'],
    inventoryFingerprintsUnchanged=inventory['unchangedInventory'], listingErrors=inventory['listingErrors'],
    databaseBackup=str(args.backup / 'database.dump'), backupSha256=backup['sha256'],
    repeatedRunNewLinks=repeat['attached'], repeatedRunUnchanged=repeat['databaseUnchanged'],
    rollbackVerified=rollback['passed'], preservation=preservation,
    reasons=dict(Counter(reason for p in manual for reason in p['reasons'])))
# Sizes in PostgreSQL's to_jsonb output can be either numbers or strings.
summary['modelArchiveBytes'] = sum(int(f['size_bytes'] or 0) for f in snapshot['storage_files']
                                 if any(s['id'] == f['storage_id'] and s['key'] == 'LIBRARY' for s in snapshot['storage_locations']))
(directory / 'summary.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2) + '\n')
print(json.dumps({k: v for k, v in summary.items() if k not in ['reasons','preservation']}, ensure_ascii=False))
