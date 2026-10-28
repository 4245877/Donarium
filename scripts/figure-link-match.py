#!/usr/bin/env python3
"""Conservative, offline figure matching. Preview only: never writes the database.

Original source names must agree and uniquely identify an unchanged archive.
Member directories must independently contain actual model files and an identity
token. Fuzzy/transliterated names produce suggestions only. Version numbers,
support/NSFW qualifiers, creator names and explicit archive extensions are kept.
"""
import argparse
from collections import Counter, defaultdict
import difflib
import hashlib
import json
from pathlib import Path
import re
import unicodedata

ARCHIVE = {'.rar', '.zip', '.7z', '.gz', '.tar'}
MODEL = {'.stl', '.obj', '.3mf', '.blend', '.step', '.stp', '.ply', '.fbx', '.glb', '.gltf', '.amf', '.f3d', '.scad', '.max'}
FRANCHISES = {
    'Dragon Ball': ['dragon ball', 'dbz'], 'One Piece': ['one piece', 'one peace'],
    'Genshin Impact': ['genshin impact'], 'Zenless Zone Zero': ['zenless zone zero'],
    'My Hero Academia': ['my hero academia', 'my hero acedemia', 'my hero academy', 'boku no hero'],
    'Blue Archive': ['blue archive'], 'Azur Lane': ['azur lane', 'azure lane'],
    'Chainsaw Man': ['chainsaw man', 'shawsan man'], 'Naruto': ['naruto', 'boruto'],
    'Bleach': ['bleach'], 'Honkai': ['honkai'], 'Nier': ['nier'],
    'Demon Slayer': ['demon slayer', 'kimetsu no yaiba'], 'Jujutsu Kaisen': ['jujutsu kaisen', 'jujutsu kaizen'],
    'One Punch Man': ['one punch man'], 'Overlord': ['overlord'], 'Pokemon': ['pokemon'],
    'Fate': ['fate'], 'Hollow Knight': ['hollow knight', 'hollow nigth', 'hollowknight'],
    'Spy x Family': ['spy x family'], 'Elden Ring': ['elden ring'], 'Dark Souls': ['dark souls'],
    'Persona': ['persona'], 'Hellsing': ['hellsing'], 'Helltaker': ['helltaker'],
    'Mushoku Tensei': ['mushoku tensei', 'jobless reincarnation'], 'Konosuba': ['konosuba'],
    'Hunter x Hunter': ['hunter x hunter', 'hnter x hunter'], 'Guilty Gear': ['guilty gear'],
    'ReZero': ['re zero', 'rezero'], 'Dispatch': ['dispatch'], 'DC': ['teen titans'],
    'Marvel': ['marvel'], 'Nikke': ['nikke'], 'Blue Lock': ['blue lock'],
    'Hololive': ['hololive'], 'Star Wars': ['star wars'], 'Dandadan': ['dandadan'],
    'Solo Leveling': ['solo leveling'], 'Fullmetal Alchemist': ['fullmetal alchemist', 'стальной алхимик'],
}
# These words cannot independently establish the identity of a figure.
GENERIC = set('''a an the and of in from by for with without to no on all original character
 studio studios figure figures figurines sculpt sculpts collection collections model models
 stl obj zip rar print printing printable 3d 3dprint resin statue sculpture bust full fullsize
 scale supported unsupported presupported nonsupported non supported parts part pieces base
 diorama assembly render renders image images sfw nsfw nude naked clothed version ver v
 top3dhub t me other home идеально большая большой цельная большой без поддержек printmodel
 genshin impact honkai star rail zenless zone zero azure azur lane one piece peace dragon ball
 boku hero academia acedemia academy my demon slayer kimetsu yaiba naruto boruto bleach
 pokemon blue archive hunter fate hololive vtuber nier automata monster musume girl girls
 overlord punch man chainsaw soul souls eater hollow knight silksong re zero rezero dbz
 kaidan kaidan3d 3dmoonn myanimate tanuki neko tenshi pikky prints pink chuya factory
 basu bulkmancer bulkamancer serik ryodan moonfigures moon brunoart3d brunoart3dstl
 hybris kuru inaki eggma eggmastudios salt saltSculpt lucas perez freyas fantasys nomnom
 ukupalua rubim momoji bastet lionrealm ca cw fides fidesfigure sin3dstudio
 remy remu gr8tech individual peach serikcollection yoyo ydeval chibistation l pomc
 comic month reward march january february august september october november december poke
 animate bruno art3d art3dstl azerama abe3d getcha gacha gray world corporation gatsu
 esmonster kiba pokerus spray hikari daniel villanueva general buta merge project cwstudio
 k77 ero waifus dhjwai eclipse clouds patreon eddy workshop funservice paddyy jedirayswill
 inari lion realm gabriel meyer creator h3ll code geass collector package fanart commission
 exclusive common assemble diroama initiales iniciales pokemons pastel memories spice wolf touhou
 bizarre adventure xenoblade chronicles stellar blade wuthering waves quest male female
 hyperdimension neptunia copyright readme advertisement miniatures stlhome shop reward
 witch bunny maid apron succubus beast swimsuit halloween chibi wedding nsfw blood espada'''.lower().split())


def stem(value):
    value = value.strip().replace('\\', '/').split('/')[-1]
    suffix = Path(value).suffix.lower()
    return value[:-len(suffix)] if suffix in ARCHIVE | MODEL else value


def key(value):
    return ''.join(c for c in unicodedata.normalize('NFKC', stem(value)).casefold() if c.isalnum())


def tokens(value):
    value = re.sub(r'([a-z])([A-Z])', r'\1 \2', unicodedata.normalize('NFKC', value))
    return set(re.findall(r'[^\W_]+', value.casefold()))


def franchises(value):
    normalized = ''.join(c for c in value.casefold() if c.isalnum())
    return {name for name, aliases in FRANCHISES.items()
            if any(''.join(c for c in a if c.isalnum()) in normalized for a in aliases)}


def identity(value):
    return {v for v in tokens(stem(value)) if v not in GENERIC and len(v) >= 2 and not v.isdigit()}


def choose(names, files):
    """No fuzzy positive matches; spelling/case collisions always remain manual."""
    if not names:
        return [], ['В карточке отсутствует исходное имя файла']
    keys = {key(n) for n in names}
    if len(keys) != 1:
        return [], ['Источники карточки содержат противоречащие друг другу имена файлов']
    candidates = [f for f in files if key(f['name']) in keys]
    explicit = {Path(n).suffix.lower() for n in names if Path(n).suffix.lower() in ARCHIVE | MODEL}
    if len(explicit) > 1:
        return candidates, ['Источники задают разные форматы оригинального файла']
    if explicit:
        candidates = [f for f in candidates if Path(f['name']).suffix.lower() in explicit]
    if not candidates:
        return [], ['Нет файла с полным исходным именем; нечёткое сходство не принято']
    if len(candidates) > 1:
        return candidates, ['Несколько файлов имеют одинаковое нормализованное имя; регистр не определяет версию']
    return candidates, []


def source_names(product, links, assets):
    values = []
    for link in links:
        meta = link['metadata']
        for field in ['source_fields', 'portable_record']:
            name = meta.get(field, {}).get('Имя STL/ZIP-файла')
            if name:
                values.append((field, name.strip()))
    for line in product['description'].splitlines():
        if line.startswith('Имя STL/ZIP-файла:'):
            for name in line.split(':', 1)[1].split(' | '):
                if name.strip():
                    values.append(('description', name.strip()))
    for asset in assets:
        if asset['kind'] in ['archive', 'model', 'source'] and asset['external_url']:
            values.append(('existing_external_asset', asset['name']))
    return values


def evaluate(product, names, files, listings, existing, categories):
    candidates, reasons = choose([name for _, name in names], files)
    result = dict(productId=product['id'], title=product['title'], categories=categories,
                  sources=[dict(origin=o, name=n) for o, n in names], candidates=[f['id'] for f in candidates],
                  reasons=reasons, status='manual', evidence={})
    if len(candidates) != 1 or reasons:
        result['status'] = 'ambiguous' if candidates else 'missing'
        return result
    file = candidates[0]
    result.update(fileId=file['id'], root='LIBRARY', path=file['relative_path'])
    listing = listings.get(file['relative_path'])
    if not listing:
        reasons.append('Отсутствует полное оглавление архива')
        return result
    result['fingerprint'] = listing['fingerprint']
    result['sha256'] = listing['sha256']
    result['evidence']['sourceKey'] = key(file['name'])
    if listing['error']:
        reasons.append('Ошибка чтения оглавления: ' + listing['error'])
    if not listing['inventoryUnchanged'] or listing['sha256'] != file['sha256'] or str(listing['fingerprint']['size']) != str(file['size_bytes']):
        reasons.append('Размер, отпечаток или прежняя SHA-256-опись не согласованы с реестром')
    if file['status'] != 'available':
        reasons.append('В реестре файл не имеет состояния available')
    members = [e for e in listing['entries'] if e.get('Folder') != '+']
    models = [e for e in members if Path(e['Path']).suffix.lower() in MODEL]
    nested = [e['Path'] for e in members if Path(e['Path']).suffix.lower() in ARCHIVE]
    result['evidence'].update(modelMembers=len(models), nestedArchives=nested,
                              archiveMembers=len(members))
    if not models:
        reasons.append('Нет непосредственно проверяемых моделей; вложенные архивы требуют отдельной проверки')
    source_identity = identity(file['name'])
    model_text = ' '.join(e['Path'] for e in models)
    expected_franchises = {name for name, aliases in FRANCHISES.items()
                           if any(key(category) in {key(name), *(key(a) for a in aliases)} for category in categories)}
    # A part called one_piece.stl means a one-piece mesh, not the franchise.
    # Detect franchise labels only in package/directory names, independently.
    actual_franchises = franchises(file['name'])
    for entry in models:
        actual_franchises |= franchises(str(Path(entry['Path']).parent))
    result['evidence']['expectedFranchises'] = sorted(expected_franchises)
    result['evidence']['memberFranchises'] = sorted(actual_franchises)
    if expected_franchises and actual_franchises and not expected_franchises & actual_franchises:
        reasons.append('Явные названия франшиз внутри пакета противоречат категории карточки: '
                       + ', '.join(sorted(expected_franchises)) + ' / ' + ', '.join(sorted(actual_franchises)))
    matched = sorted(source_identity & tokens(model_text))
    result['evidence']['identityTokens'] = sorted(source_identity)
    result['evidence']['memberIdentityMatches'] = matched
    if not matched:
        reasons.append('Имена деталей/папок внутри архива не подтверждают конкретного персонажа или версию')
    multi_subject = re.split(r'\s+(?:and|vs|x|&)\s+', stem(file['name']).replace('_', ' '), flags=re.I)
    if len(multi_subject) > 1:
        for subject in multi_subject:
            required_identity = identity(subject)
            if required_identity and not required_identity & tokens(model_text):
                reasons.append('Не подтверждён один из участников заявленной композиции: ' + subject.strip())
    # Explicit package requirements must also be visible inside the archive.
    source_lower = stem(file['name']).casefold()
    member_lower = model_text.casefold()
    requirements = []
    if re.search(r'nsfw|nude|naked', source_lower):
        requirements.append(('NSFW', r'nsfw|nude|naked|naked|sexy|nudes'))
    if re.search(r'presupported|pre.supported', source_lower):
        requirements.append(('presupported', r'presupport|pre.support|(?<!un)support'))
    if re.search(r'unsupported|non.supported', source_lower):
        requirements.append(('unsupported', r'unsupport|non.support|no.support'))
    if 'bust' in tokens(source_lower):
        requirements.append(('bust', r'bust|busto'))
    for qualifier in ['anbu', 'vigilante', 'baryon', 'dangai', 'bunny', 'maid', 'apron', 'succubus',
                      'beast', 'swimsuit', 'halloween', 'chibi', 'wedding', 'fullsize']:
        if qualifier in tokens(source_lower):
            requirements.append((qualifier, re.escape(qualifier)))
    explicit_version = re.search(r'(?:^|[_. -])v(\d+)(?:$|[_. -])', source_lower)
    if explicit_version:
        requirements.append(('v'+explicit_version[1], rf'(?:^|[^a-z0-9])v[_. -]*{explicit_version[1]}(?:$|[^0-9])'))
    numbered = re.search(r'([a-z]{3,})[_ -](\d{1,2})$', source_lower)
    if numbered:
        group = numbered[1]
        versions = {m[1] for f in files if (m := re.search(re.escape(group)+r'[_ -](\d{1,2})$', stem(f['name']).casefold()))}
        if len(versions) > 1:
            requirements.append((group+' '+numbered[2], re.escape(group)+rf'[^a-z0-9]*{numbered[2]}(?:$|[^0-9])'))
    result['evidence']['packageRequirements'] = [label for label, _ in requirements]
    for label, pattern in requirements:
        if not re.search(pattern, member_lower):
            reasons.append(f'Оглавление не подтверждает заявленную комплектацию: {label}')
    if any(e.get('Split Before') == '+' or e.get('Split After') == '+' for e in members) or re.search(r'\.part\d+\.', file['name'], re.I):
        reasons.append('Многотомный архив: полнота всех частей не подтверждена')
    if any(e.get('Encrypted') == '+' for e in members):
        reasons.append('Зашифрованное содержимое требует ручной проверки')
    if any(e.get('Symbolic Link') or e.get('Hard Link') for e in members):
        reasons.append('В архиве есть ссылки; состав требует ручной проверки')
    # Bare names that are also prefixes/subsets of other package names do not
    # distinguish pose/creator/package, even when an extension matches exactly.
    source_tokens = tokens(stem(file['name']))
    meaningful = {t for t in source_tokens if t not in GENERIC and not t.isdigit()}
    rich = any(t in source_tokens for t in ['studio', 'studios', 'figures', 'figurines', 'presupported', 'unsupported',
                                           'fullsize', 'bust', 'diorama', 'nsfw', 'bunny', 'swimsuit', 'chibi'])
    rich = rich or any(creator in file['name'].lower() for creator in ['kaidan', 'myanimate', '3dmoonn', 'tanuki',
        'chibistation', 'moonfigures', 'sin3dstudio', 'pikky', 'nomnom', 'ukupalua', 'rubim', 'neko', 'lpomc', 'hybris',
        'fides', 'momoji', 'oxo3d', 'serik', 'chuya', 'bulkaman', 'bulkmanc', 'eggma', 'hikari', 'zahen', 'ryodan'])
    rich = rich or bool(requirements) or 'mypokeprints' in file['name'].casefold()
    alternatives = []
    if meaningful and not rich:
        for other in files:
            if other['id'] != file['id'] and meaningful <= tokens(stem(other['name'])):
                alternatives.append(other['id'])
    if alternatives:
        result['candidates'] += alternatives
        reasons.append('Исходное имя не различает несколько версий этого персонажа; нужен визуальный/авторский признак')
    title = product['title'].casefold()
    if 'зоро' in title and 'goku' in file['name'].casefold():
        reasons.append('Противоречие: карточка называет Зоро / One Piece, исходный файл содержит Goku')
    if 'люди х' in title and 'invisible_woman' in file['name'].casefold():
        reasons.append('Карточка указывает «Люди Х», файл — Invisible Woman; франшиза требует уточнения')
    if key(file['name']) in ['darksouls', 'march2024reward']:
        reasons.append('Имя описывает франшизу/месячный пакет и не доказывает конкретную фигурку и комплектацию')
    if existing:
        if len(existing) == 1 and existing[0]['file_id'] == file['id'] and not reasons:
            result['status'] = 'already_correct'
        else:
            reasons.append('Существующая активная привязка сохранена: требуется ручная проверка')
    if not reasons and not existing:
        result['status'] = 'ready'
    return result


def build(snapshot, audit):
    data = snapshot['data']
    locations = {s['id']: s['key'] for s in data['storage_locations']}
    files = [f for f in data['storage_files'] if locations[f['storage_id']] == 'LIBRARY']
    listings = {r['path']: r for r in audit if r.get('type') == 'archive'}
    assert len(listings) == len(files), 'Full archive inventory is required'
    links, assets, product_categories = defaultdict(list), defaultdict(list), defaultdict(list)
    categories = {c['id']: c['name'] for c in data['categories']}
    for row in data['external_links']:
        links[row['product_id']].append(row)
    for row in data['assets']:
        assets[row['product_id']].append(row)
    for row in data['product_categories']:
        product_categories[row['product_id']].append(categories[row['category_id']])
    rows = []
    for product in sorted(data['products'], key=lambda p: p['id']):
        existing = [a for a in assets[product['id']] if a['metadata'].get('role') == 'figure' and not a['retired_at']]
        names = source_names(product, links[product['id']], assets[product['id']])
        row = evaluate(product, names, files, listings, existing, product_categories[product['id']])
        row['productSnapshot'] = product
        row['existingAssetIds'] = [a['id'] for a in assets[product['id']]]
        if not row['candidates']:
            query = names[0][1] if names else ''
            suggestions = sorted(((difflib.SequenceMatcher(None, key(query), key(f['name'])).ratio(), f)
                                  for f in files), key=lambda item: -item[0])
            row['suggestions'] = [dict(fileId=f['id'], path=f['relative_path'], similarity=round(score, 3))
                                  for score, f in suggestions[:8] if score >= .50 and query]
            # Internal names can help the owner investigate a renamed package,
            # but cannot prove author/version and therefore never enable writes.
            hints = identity(query)
            if hints:
                seen = {s['fileId'] for s in row['suggestions']}
                for f in files:
                    listing = listings.get(f['relative_path'])
                    members = ' '.join(e['Path'] for e in listing['entries']) if listing else ''
                    if f['id'] not in seen and hints <= tokens(members):
                        row['suggestions'].append(dict(fileId=f['id'], path=f['relative_path'],
                                                       memberTokens=sorted(hints), similarity=None))
        rows.append(row)
    # Two cards must not silently acquire the same physical archive.
    reverse = defaultdict(list)
    for row in rows:
        if row['status'] == 'ready':
            reverse[row['fileId']].append(row)
    for group in reverse.values():
        if len(group) > 1:
            for row in group:
                row['status'] = 'manual'
                row['reasons'].append('На один файл претендуют несколько карточек')
    return dict(format='donarium-figure-link-plan', version=1, snapshotFingerprints=snapshot['fingerprints'],
                counts=dict(Counter(r['status'] for r in rows)), products=rows)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('snapshot', type=Path)
    parser.add_argument('audit', type=Path)
    parser.add_argument('destination', type=Path)
    args = parser.parse_args()
    plan = build(json.loads(args.snapshot.read_text()), [json.loads(l) for l in args.audit.read_text().splitlines()])
    text = json.dumps(plan, ensure_ascii=False, indent=2)+'\n'
    args.destination.write_text(text)
    print(json.dumps(dict(counts=plan['counts'], sha256=hashlib.sha256(text.encode()).hexdigest()), ensure_ascii=False))
