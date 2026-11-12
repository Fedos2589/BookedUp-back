# AGENTS.md

Подробные правила по темам — в скиллах `.claude/skills/`; прочитайте нужный до начала работы:

| Когда вы…                                              | Читайте                                                                                  |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| пишете Nest-код                                        | [`.claude/skills/back-nest/SKILL.md`](.claude/skills/back-nest/SKILL.md)                 |
| меняете схему БД, миграции, удаление                   | [`.claude/skills/back-prisma/SKILL.md`](.claude/skills/back-prisma/SKILL.md)             |
| трогаете вход, сессии, лимиты                          | [`.claude/skills/back-auth/SKILL.md`](.claude/skills/back-auth/SKILL.md)                 |
| добавляете маршрут под `/businesses/:businessId`, роли | [`.claude/skills/back-access/SKILL.md`](.claude/skills/back-access/SKILL.md)             |
| работаете с командой, Staff, приглашениями             | [`.claude/skills/back-team/SKILL.md`](.claude/skills/back-team/SKILL.md)                 |
| работаете с графиком и слотами                         | [`.claude/skills/back-schedule/SKILL.md`](.claude/skills/back-schedule/SKILL.md)         |
| пишете схемы запросов и ошибки                         | [`.claude/skills/back-api-contract/SKILL.md`](.claude/skills/back-api-contract/SKILL.md) |

## NestJS

Версия Nest новее, чем вы знаете; пакеты — ESM. Первопартийные пакеты и ESM-правила — скилл `back-nest`.

## BookedUp

API сервиса онлайн-записи для малого бизнеса (спортшколы, бьюти). Фронт — репозиторий BookedUp-front; он генерирует клиент из `/api/docs-json` через Orval, поэтому Swagger-описание — это контракт: у каждого эндпоинта `@ApiTags`, типизированные ответы (`@ApiOkResponse` с DTO), иначе на фронте получится `unknown`.

### Три правила с первого дня

1. **Мультиарендность.** У каждой таблицы с данными бизнеса есть `businessId`, и каждый запрос фильтруется по нему. Доступ проверяет guard, а не каждый сервис по-своему. Запрос без `businessId` в `where` к такой таблице — баг. Как именно — в разделе «Доступ к бизнесу».
2. **Время.** В базе всё в UTC (`timestamptz`). У `Business` свой часовой пояс (IANA, `Europe/Moscow`), слоты и рабочие часы считаются в нём. Не использовать часовой пояс сервера.
3. **Двойная запись невозможна на уровне Postgres.** На записи мастера — ограничение `EXCLUDE USING gist` по диапазону времени (`tstzrange`) для `staffId` (расширение `btree_gist`). Prisma этого не выражает — ограничение пишется SQL-ом в миграции. Проверка в коде — только для понятной ошибки, не вместо ограничения.

### Что где

- `src/config/env.ts` — env, проверяется zod при старте. Переменные читаются только через `ConfigService<Env, true>`, не через `process.env`. Новая переменная — в схему и в `.env.example`.
- Prisma, миграции, таблицы — скилл `back-prisma`; владелец, `Staff`/`Membership`, приглашения — `back-team`; график и слоты — `back-schedule`.
- `APP_URL` — адрес фронта, из него строятся ссылки, которые отдаёт API (приглашения); путь сохраняется (`invitationLink`). В production обязателен, иначе ссылки вели бы на localhost; в остальных окружениях по умолчанию dev-сервер Vite.
- `src/app.setup.ts` — `configureApp()`: то, что нужно приложению сверх `AppModule` (сейчас `enableCsrfProtection()`). Вызывают и `main.ts`, и `test/test-app.ts`, чтобы тесты шли с тем же, что и прод. Настройку, которую можно выразить провайдером (`APP_PIPE`, `APP_GUARD`), кладём в `AppModule`, а не сюда.
- Очереди — `@nestjs/bullmq`, соединение уже настроено в `AppModule`; новая очередь — `BullModule.registerQueue` в своём модуле.
- Логи — `nestjs-pino`, не `console.log`. Ошибку кладём под ключ `err` (`logger.warn({ err: error }, …)`): только его pino разбирает в тип, сообщение и стек, под другим ключом `Error` выйдет в лог как `{}`.

### Вход, доступ, ввод, ошибки

Каждый маршрут требует входа (`@Public()` — осознанное решение) и явной проверки (`@Can…`); под `/businesses/:businessId` — `@MemberOfBusiness()`. Вход и лимиты — скилл `back-auth`, доступ и роли — `back-access`, схемы и ответы об ошибках — `back-api-contract`.

### Проверки

Интеграционные тесты разных файлов идут параллельно в одной базе: уникальные значения в них (email, slug) — из `randomUUID()`, не из часов.

Что запускается само:

- **pre-commit** (husky + lint-staged): `oxlint --type-aware --deny-warnings --fix` и Prettier на добавленных в коммит файлах. Ошибку или предупреждение линтера, которые не исправить автоматически, хук не пропустит — чините, а не `--no-verify`.
- **pre-push**: `npm run typecheck` и `npm test` (без Docker).
- **CI** (`.github/workflows/ci.yml`) на каждом PR и на main: всё из списка ниже, интеграционные тесты — на Postgres из Testcontainers. PR мержится с зелёным CI.

Форматирование — Prettier, 120 колонок (`.prettierrc`): `npm run format`. Node — `^22.22.3 || ^24.15.0 || >=26` (`.nvmrc`, `engines`; этого требуют `@nestjs/cli` через `@angular-devkit/*` и lint-staged), `npm install` на более старой версии падает (`engine-strict`). Хуки ставит `npm install` (скрипт `prepare`).

Перед PR вручную то же, что в CI:

```bash
npm run format:check
npm run typecheck
npm run lint
npm test
npm run test:e2e
npm run test:int   # нужен запущенный Docker
npm run build
```

Postgres и Redis локально — `docker compose up -d`.
