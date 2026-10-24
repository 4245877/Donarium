# Резервное копирование и восстановление DONARIUM

`JSON` и переносимый ZIP предназначены для обмена библиотекой. Полная резервная копия дополнительно сохраняет PostgreSQL, включая схему и историю миграций, и все настроенные файловые корни. Скрипт не удаляет данные и не изменяет оригиналы.

## Создание копии

Нужны Node.js 22+, GNU tar и PostgreSQL `pg_dump` версии не ниже сервера. Для Docker-установки можно использовать `pg_dump` уже установленный в контейнере PostgreSQL. В `.env` должны быть заданы `DATABASE_URL`, `STORAGE_ROOTS` (или `STORAGE_ROOT`) и `MANAGED_STORAGE_ROOT`.

Перед копированием остановите DONARIUM и программы, изменяющие подключённые каталоги: иначе дамп БД и файлы могут представлять разные моменты времени. Два явных флага подтверждают выбранную библиотеку и остановку записи. Скрипт принимает только БД с именем `donarium` или `donarium_<suffix>`.

Docker, из корня checkout:

```bash
docker compose -f compose.yml -f compose.postgres.yml stop app
mkdir -p /srv/backups/donarium
BACKUP_CONFIRM=donarium BACKUP_QUIESCED=donarium \
  BACKUP_DB_CONTAINER="$(docker compose -f compose.yml -f compose.postgres.yml ps -q db)" \
  node scripts/backup.mjs /srv/backups/donarium/2026-10-24
# Возобновляйте запись только после сообщения Backup complete.
docker compose -f compose.yml -f compose.postgres.yml start app
```

Для установленного на хосте PostgreSQL используйте тот же скрипт без `BACKUP_DB_CONTAINER`. Если `DATABASE_URL` содержит Docker-hostname `db`, для клиента на хосте задайте `BACKUP_DATABASE_URL` с адресом `127.0.0.1:5548`. Скрипт не выводит URL и пароли. Если `STORAGE_ROOTS` содержит контейнерные пути (например `/library/models`), задайте `BACKUP_STORAGE_ROOTS` с теми же ключами и настоящими путями хоста (например `[{"key":"MODELS","path":"/mnt/models"}]`). Управляемый корень для backup берётся из хостового `MANAGED_STORAGE_ROOT`, по умолчанию `var/uploads`.

Каталог назначения должен быть новым, его родитель должен существовать. Он должен находиться вне всех корней библиотеки. Получится:

```text
2026-10-24/
  backup.json
  database.dump
  storage-DONARIUM_UPLOADS.tar
  storage-LIBRARY.tar             # отдельный tar на каждый настроенный корень
```

`backup.json` содержит версию, исходные пути корней и SHA-256 каждого файла копии; секретов `.env` в нём нет. Каталог создаётся с правами `0700`, файлы — `0600`. Храните настройки и пароль владельца отдельно: они не включены в копию. Скрипт не следует символическим ссылкам при архивации. Незавершённая копия остаётся в созданном каталоге без финального `backup.json` и не считается пригодной к восстановлению.

## Проверка целостности

Из каталога резервной копии:

```bash
node --input-type=module <<'JS'
import { readFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
const manifest = JSON.parse(await readFile('backup.json', 'utf8'));
if (manifest.format !== 'donarium-backup' || manifest.version !== 1) throw Error('Unknown format');
for (const entry of manifest.files) {
  if (!/^(database\.dump|storage-[A-Z][A-Z0-9_]*\.tar)$/.test(entry.file)) throw Error('Unsafe filename');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(entry.file)) hash.update(chunk);
  if (hash.digest('hex') !== entry.sha256) throw Error(`Checksum mismatch: ${entry.file}`);
}
console.log('All checksums match');
JS
```

## Восстановление в отдельную установку

Сначала проверьте SHA-256. Восстанавливайте только доверенную собственную резервную копию, в новую пустую БД и пустые файловые каталоги. Команды ниже не очищают существующую БД.

Docker PostgreSQL из этого проекта, пример нового имени БД:

```bash
docker compose -f compose.yml -f compose.postgres.yml exec -T db \
  createdb -U donarium donarium_restore_20261024
docker compose -f compose.yml -f compose.postgres.yml exec -T db \
  pg_restore -U donarium --no-owner --no-acl -d donarium_restore_20261024 \
  < /srv/backups/donarium/2026-10-24/database.dump
mkdir -p /srv/donarium-restored/uploads /srv/donarium-restored/library
tar -xf /srv/backups/donarium/2026-10-24/storage-DONARIUM_UPLOADS.tar -C /srv/donarium-restored/uploads
tar -xf /srv/backups/donarium/2026-10-24/storage-LIBRARY.tar -C /srv/donarium-restored/library
```

Для PostgreSQL на хосте: `createdb donarium_restore_20261024`, затем `pg_restore --no-owner --no-acl -d donarium_restore_20261024 /path/database.dump`; параметры подключения задайте переменными `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`.

В настройках изолированной установки укажите URL новой БД, `MANAGED_STORAGE_ROOT=/srv/donarium-restored/uploads` и корни с прежними **ключами** (`LIBRARY` в примере), но новыми физическими путями. При Docker-запуске смонтируйте соответствующие каталоги. Владельцем загруженного хранилища должен быть пользователь процесса DONARIUM. После восстановления запустите миграции текущей версии, затем приложение и проверьте каталог, обложки и скачивание. Переключать рабочую установку на восстановленную БД следует только после этой проверки.

## Изолированное интеграционное окружение

```bash
node scripts/test-integration.mjs --prepare-only
# Полный набор тестов с PostgreSQL:
node scripts/test-integration.mjs
# Удалить только временный тестовый контейнер и его tmpfs:
node scripts/test-integration.mjs --down
```

Runner использует исключительно Compose-проект `donarium-audit-test`, PostgreSQL 16 на `127.0.0.1:5549` и временный `tmpfs`. Рабочие volumes, сеть SKUFnya и обычный `DATABASE_URL` не используются. Создаются две БД `donarium_test_source` и `donarium_test_restore`; миграции применяются к обеим. Шесть тестовых карточек добавляются только в пустую source-БД. URL без паролей сохраняются в `/tmp/donarium-integration-env.json`; restore-БД предназначена для проверки переносимости. Тестовый контейнер остаётся запущенным до `--down`; его данные исчезают при пересоздании.

На 24 октября 2026 года резервная копия проверена на этом изолированном PostgreSQL: создан custom dump и два файловых tar, все три SHA-256 совпали, БД восстановлена в новую `donarium_test_backup` (6 карточек), извлечённый файл совпал с исходным побайтово. Рабочая БД и пользовательские файлы в проверке не использовались.

## Безопасность миграции 002

Исходный `001_initial.sql` не изменялся. `002_library.sql` добавляет поля и связи; заново строятся только вычисляемые поисковые колонки и индексы. До применения к существующей библиотеке создайте backup описанным выше способом. Миграции выполняются транзакционно под advisory lock; ошибка откатывает изменения текущего файла. Они не запускаются автоматически вместе с API.

Новый индекс запрещает повторную привязку одного пути к одной карточке. Если в старой БД такие связи уже существуют, preflight миграции остановится, сообщит количество групп и сохранит все записи. Просмотреть группы можно в локальном PostgreSQL-клиенте:

```sql
SELECT product_id, storage_id, relative_path, count(*) AS links,
       array_agg(id ORDER BY created_at, id) AS asset_ids
FROM assets
WHERE storage_id IS NOT NULL
GROUP BY product_id, storage_id, relative_path
HAVING count(*) > 1;
```

Не удаляйте их массово: разные ссылки могут содержать версии или другие полезные метаданные. После backup выберите сохраняемую связь, перенесите нужные метаданные и исправьте только подтверждённые дубликаты. Затем повторите `DB_MIGRATION_CONFIRM=donarium npm run db:migrate`. Сам runner не удаляет связи, товары или файлы. Для новой пустой БД preflight не требует дополнительных действий.
