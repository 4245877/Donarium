# Проверки DONARIUM — 24 октября 2026

Исторические результаты; актуальные проверки и ограничения приведены в [техническом аудите 28.10.2026](TECHNICAL_AUDIT_2026-10-28.md).

Все изменения проверяются на изолированных данных. Рабочая база не очищалась. Внешняя библиотека владельца не подключалась по его указанию.

## Автоматизированные сценарии

| Набор | Результат | Что проверено |
|---|---:|---|
| API | 9/9 | поиск, категории, пагинация, валидация, static traversal, ошибки без секретов, health503 |
| Пароль владельца | 2/2 | защита API/изображений/экспорта, вход/выход, Origin, лимит попыток |
| Файловая безопасность | 6/6 | traversal, symlink, замена inode, streaming upload, SHA-256, лимит, scan/cancel |
| Формат переноса | 8/8 | ZIP path/symlink/encryption/duplicate/size, JSON bounds, версия, hashes, связи и обложки |
| PostgreSQL чтение | 4/4 | кириллица/литеральный поиск, фильтры, пагинация, bigint, настоящий API |
| PostgreSQL CRUD | 2/2 | nullableSKU, категории/теги/статус, атомарность, уникальность, принадлежность обложки |
| PostgreSQL файлы/импорт | 3/3 | link/upload/download/ZIP64,8 thumbnails,missing/unlink,repeat import |
| Переносимость | 2/2 | другая БД+storage, IDs/даты/связи/bytes/SHA-256,skip/copy conflicts |
| Восстановление после сбоя | 3/3 | rollback на COMMIT после move, restart receipts, потерянный ответ успешного COMMIT |

Итого: **39/39 PASS, 0 skipped** в окончательном полном запуске. Добавлен сценарий распознавания вручную связанных файлов и отказа при неоднозначности.

Окружение: Node.js22.23.2, PostgreSQL16, Fastify5, временные schemas `storage_*`, `portable_*`, `recovery_*` внутри двух разных `donarium_test_*` БД. Файлы в `/tmp`. Изолированный Compose-проект `donarium-audit-test`, loopback5549.

Проверка миграции002 с намеренными duplicate assets: runner остановился до изменения схемы; обе исходные связи сохранились. Успешно применены001–005 в отдельных пустых тестовых БД. Новая рабочая БД создана отдельно, без seed.

## Браузер

Настоящий Chromium, PostgreSQL и временные файловые корни: **6/6 PASS**. Проверены неверный пароль, поиск+URL, mobile390px, retry, создание/фото/редактирование/reload/delete; полный маршрут link/download/ZIP/unlink/scan/confirm/rescan/CSV/JSON/exportZIP/restorepreview/copy/confirm. После UI-правок последний маршрут повторён отдельно —1/1PASS. QA-серверы остановлены, их schema и fixtures очищены.

Скриншоты: `var/qa/library-desktop.png`, `var/qa/library-mobile.png`.

## Сборка и backup

- `npm run typecheck`: успешно (включает shared/API/web/scripts/tests).
- `npm run build`: успешно (shared→frontend→backend).
- Production Docker runtime и maintenance stage собираются с Node22.
- npm audit при установке/production prune:0 известных уязвимостей на момент проверки.
- Backup: custom dump+дваtar,3/3 SHA-256; восстановление в новую `donarium_test_backup` дало6 карточек, файл совпал побайтово.
- Перед переключением нового PostgreSQL создан baseline `backups/initial-postgres-20261024`.

## Непроверенное

Доступ с отдельного физического телефона/ПК не выполнялся; Chromium проверяет мобильный viewport, а HTTP проверяется с сервера по его LAN-IP. Не выполнялись терабайтные выгрузки, нагрузка100000+товаров и чтение реальной внешней библиотеки. Эти проверки не заявляются успешными.

## Рабочая установка после переключения

Контейнеры `donarium-app-1` и `donarium-db-1` — healthy. `http://192.168.0.151:4180/health`:200,version0.2.0,modepostgres,databaseconnected. Проверены HTTP-страницы каталога/создания/импорта/переноса/настроек,401 без cookie,вход200,каталог200,загрузкаconfigured,валидация400,logout и повторный401. В рабочую БД не создавались тестовые товары; total0. Критических ошибок в журналах после запуска нет.
