#!/usr/bin/env python3
"""Render a local, searchable approval report; never modifies the database or originals."""
import collections, csv, html, json, os, pathlib, re, sys
source=pathlib.Path(sys.argv[1]).resolve()
report=json.loads(source.read_text())
if report.get('productionChanged') is not False:raise SystemExit('Only a rehearsal report is accepted')
summary=report['summary']
if summary['available']!=summary['files'] or summary['issues'] or summary['unverified']:raise SystemExit('Rehearsal must have verified all files')
journal=pathlib.Path(sys.argv[2]).resolve()
files={}
for line in journal.read_text().splitlines():
 row=json.loads(line);files[row['name']]=row
selected={row['archive'] for row in report['matches'] if row['archive']}
unselected=[files[name] for name in sorted(files.keys()-selected)]
groups=collections.defaultdict(list)
for row in files.values():groups[(row['sha256'],row['size'])].append(row['name'])
duplicates=[{'sha256':key[0],'size':key[1],'files':names} for key,names in groups.items() if len(names)>1]
proof={'archives':len(files),'bytes':sum(f['size'] for f in files.values()),'duplicateGroups':len(duplicates),'duplicateFiles':sum(len(d['files']) for d in duplicates),'duplicates':duplicates,'unselectedFiles':unselected,'caseSensitiveExample':[r for r in files.values() if r['name'].lower()=='2b_-_nier_automata.rar']}
def write_private(path,text):
 fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
 with os.fdopen(fd,'w') as stream:stream.write(text)
write_private(source.with_name('library-checksum-summary.json'),json.dumps(proof,ensure_ascii=False,indent=2))
e=lambda value:html.escape(str(value or ''),quote=True)
labels={'exact':'Точное имя','stem':'Без расширения','normalized':'Нормализованное','missing':'Без кандидата','ambiguous':'Неоднозначное','manual':'Ручное'}
body=[]
for row in report['matches']:
 method=row['method'];body.append('<tr data-method="'+e(method)+'">'+''.join('<td>'+e(value)+'</td>' for value in [row['title'],row['source_name'],row['archive'],labels.get(method,method),row['file_status'],row['sha256'],row['product_id']])+'</tr>')
counts=collections.Counter(row['method'] for row in report['matches'])
unlinked=''.join('<tr><td>'+e(r['name'])+'</td><td>'+e(r['size'])+'</td><td>'+e(r['sha256'])+'</td></tr>' for r in unselected)
duprows=''.join('<tr><td>'+e('\n'.join(r['files']))+'</td><td>'+e(r['size'])+'</td><td>'+e(r['sha256'])+'</td></tr>' for r in duplicates)
page='''<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Donarium — проверка соответствий</title>
<style>body{font:15px system-ui;background:#171921;color:#eee;margin:24px}h1{font-size:24px}p{max-width:1000px;line-height:1.5}input,select{font:inherit;color:inherit;background:#282c38;padding:10px;border:1px solid #555;border-radius:5px}input{min-width:280px}.scroll{overflow:auto;margin-top:16px}table{border-collapse:collapse;width:100%;font-size:13px}th,td{text-align:left;padding:10px;border-bottom:1px solid #383c47;vertical-align:top}th{white-space:nowrap;color:#bfc7f3}td{white-space:pre-wrap;overflow-wrap:anywhere}tr[hidden]{display:none}td:nth-last-child(2){font-family:monospace;min-width:180px}small{color:#b9bfce}h2{margin-top:32px}#count{margin-left:12px}</style>
<h1>Donarium: соответствия товаров и архивов</h1><p>Это предпросмотр на восстановленной копии БД. На рабочей установке связи ещё не применялись. Совпадение имени и проверенный SHA-256 архива не доказывают тождество модели исходному файлу в Google Drive. Решения подтверждает владелец.</p>
<p>Проверено файлов: <b>FILES</b>; архивов: <b>ARCHIVES</b>. Точное имя: <b>EXACT</b>; без расширения: <b>STEM</b>; нормализованное: <b>NORMALIZED</b>; без кандидата: <b>MISSING</b>. Не выбрано архивов: <b>UNSELECTED</b>.</p>
<p><small>Для 160 нормализованных соответствий предусмотрено отдельное подтверждение в разделе «Файлы» Donarium после согласованного внедрения. Этот отчёт ничего не применяет.</small></p>
<input id="search" placeholder="Поиск по товару, имени или SHA-256"><select id="method"><option value="normalized">Нормализованные</option><option value="all">Все</option><option value="exact">Точное имя</option><option value="stem">Без расширения</option><option value="missing">Без кандидата</option></select><span id="count"></span>
<div class="scroll"><table id="matches"><thead><tr><th>Товар</th><th>Исходное имя</th><th>Архив</th><th>Совпадение</th><th>Доступность</th><th>SHA-256</th><th>UUID товара</th></tr></thead><tbody>MATCHES</tbody></table></div>
<h2>Не выбранные архивы</h2><div class="scroll"><table><thead><tr><th>Имя</th><th>Байты</th><th>SHA-256</th></tr></thead><tbody>UNLINKED</tbody></table></div>
<h2>Совпадения размера и SHA-256</h2><p>Оригиналы сохранены раздельно. Удаление или объединение не выполнялось.</p><div class="scroll"><table><thead><tr><th>Файлы</th><th>Байты</th><th>SHA-256</th></tr></thead><tbody>DUPLICATES</tbody></table></div>
<script>const search=document.querySelector('#search'),method=document.querySelector('#method'),rows=[...document.querySelectorAll('#matches tbody tr')];function filter(){let n=0;const q=search.value.toLocaleLowerCase();for(const row of rows){const show=(method.value==='all'||row.dataset.method===method.value)&&row.textContent.toLocaleLowerCase().includes(q);row.hidden=!show;if(show)n++;}document.querySelector('#count').textContent='Показано: '+n;}search.addEventListener('input',filter);method.addEventListener('change',filter);filter();</script></html>'''
values=dict([('FILES',summary['files']),('ARCHIVES',len(files)),('EXACT',counts['exact']),('STEM',counts['stem']),('NORMALIZED',counts['normalized']),('MISSING',counts['missing']),('UNSELECTED',len(unselected)),('MATCHES',''.join(body)),('UNLINKED',unlinked),('DUPLICATES',duprows)])
page=re.sub(r'\b(?:'+ '|'.join(values)+r')\b',lambda match:str(values[match[0]]),page)
write_private(source.with_name('migration-review.html'),page)
fd=os.open(source.with_name('migration-review.csv'),os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
with os.fdopen(fd,'w',newline='') as stream:
 writer=csv.writer(stream);writer.writerow(['product_uuid','title','source_name','archive','method','status','sha256'])
 for row in report['matches']:
  # Prefix formula-like cells so spreadsheet review cannot execute imported names.
  values=[row[key] or '' for key in ['product_id','title','source_name','archive','method','file_status','sha256']]
  writer.writerow(["'"+v if v.lstrip().startswith(('=','+','-','@')) else v for v in values])
print(json.dumps({'html':str(source.with_name('migration-review.html')),'counts':dict(counts),'unselected':len(unselected),'duplicateGroups':len(duplicates)},ensure_ascii=False))
