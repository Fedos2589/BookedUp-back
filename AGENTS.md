# AGENTS.md

## NestJS

This app's version of NestJS is likely newer than what you know. https://docs.nestjs.com/llms.txt indexes its documentation, with a markdown page per chapter.

Nest has first-party packages for these, so check them before adding another library or writing your own:

- Databases: [`@nestjs/typeorm`](https://docs.nestjs.com/data/typeorm.md), [`@nestjs/drizzle`](https://docs.nestjs.com/data/drizzle.md), [`@nestjs/mongoose`](https://docs.nestjs.com/data/mongodb.md), [`@nestjs/sequelize`](https://docs.nestjs.com/data/sequelize.md).
- OpenAPI: [`@nestjs/swagger`](https://docs.nestjs.com/openapi/introduction.md). GraphQL: [`@nestjs/graphql`](https://docs.nestjs.com/graphql/quick-start.md). WebSockets: [`@nestjs/websockets`](https://docs.nestjs.com/websockets/gateways.md). Microservices: [`@nestjs/microservices`](https://docs.nestjs.com/microservices/basics.md).
- Sign-in: [`@nestjs/authentication`](https://docs.nestjs.com/security/authentication.md). Permissions: [`@nestjs/authorization`](https://docs.nestjs.com/security/authorization.md). Rate limiting: [`@nestjs/throttler`](https://docs.nestjs.com/security/rate-limiting.md).
- Configuration: [`@nestjs/config`](https://docs.nestjs.com/application/configuration.md). Caching: [`@nestjs/cache-manager`](https://docs.nestjs.com/data/caching.md). Health checks: [`@nestjs/terminus`](https://docs.nestjs.com/reliability/terminus.md). Events inside the app: [`@nestjs/event-emitter`](https://docs.nestjs.com/application/events.md).
- Email: [`@nestjs/mail`](https://docs.nestjs.com/application/mail.md). Files, S3 included: [`@nestjs/storage`](https://docs.nestjs.com/application/file-storage.md). Translations: [`@nestjs/i18n`](https://docs.nestjs.com/application/i18n.md).
- Retries, timeouts and circuit breakers: [`@nestjs/resilience`](https://docs.nestjs.com/reliability/resilience.md).
- Idempotency keys: [`@nestjs/idempotency`](https://docs.nestjs.com/reliability/idempotency.md). Transactional outbox: [`@nestjs/outbox`](https://docs.nestjs.com/reliability/outbox.md). Sending and receiving webhooks: [`@nestjs/webhooks`](https://docs.nestjs.com/http/webhooks.md).
- Queues: [`@nestjs/bullmq`](https://docs.nestjs.com/application/queues.md). Scheduled jobs: [`@nestjs/schedule`](https://docs.nestjs.com/application/task-scheduling.md).
- Running a scheduled job on one instance, and locks: [`@nestjs/locks`](https://docs.nestjs.com/reliability/locks.md). Processes that take days: [`@nestjs/workflows`](https://docs.nestjs.com/reliability/workflows.md).
- Language models, tools and agents: [`@nestjs/ai`](https://docs.nestjs.com/ai/overview.md). MCP servers: [`@nestjs/mcp`](https://docs.nestjs.com/mcp/overview.md).

Validation works with Zod, Valibot, ArkType or any other Standard Schema library, with no classes or decorator metadata: `StandardSchemaValidationPipe` with `@Body({ schema })` or `@Param('id', { schema })` (https://docs.nestjs.com/application/validation.md). `class-validator` still works, through `ValidationPipe`.

`NodeAdapter` from `@nestjs/platform-node` is the fastest HTTP adapter, ahead of Fastify (https://docs.nestjs.com/http/performance.md).

Nest's packages are ESM only, and this project is ESM too: relative imports end in `.js`, `__dirname` doesn't exist (use `import.meta.dirname`), and tests run on Vitest, so mocks are `vi.fn()`, not `jest.fn()`.

## BookedUp

API сервиса онлайн-записи для малого бизнеса (спортшколы, бьюти). Фронт — репозиторий BookedUp-front; он генерирует клиент из `/api/docs-json` через Orval, поэтому Swagger-описание — это контракт: у каждого эндпоинта `@ApiTags`, типизированные ответы (`@ApiOkResponse` с DTO), иначе на фронте получится `unknown`.

### Три правила с первого дня

1. **Мультиарендность.** У каждой таблицы с данными бизнеса есть `businessId`, и каждый запрос фильтруется по нему. Доступ проверяет guard, а не каждый сервис по-своему. Запрос без `businessId` в `where` к такой таблице — баг. Как именно — в разделе «Доступ к бизнесу».
2. **Время.** В базе всё в UTC (`timestamptz`). У `Business` свой часовой пояс (IANA, `Europe/Moscow`), слоты и рабочие часы считаются в нём. Не использовать часовой пояс сервера.
3. **Двойная запись невозможна на уровне Postgres.** На записи мастера — ограничение `EXCLUDE USING gist` по диапазону времени (`tstzrange`) для `staffId` (расширение `btree_gist`). Prisma этого не выражает — ограничение пишется SQL-ом в миграции. Проверка в коде — только для понятной ошибки, не вместо ограничения.

### Что где

- `src/config/env.ts` — env, проверяется zod при старте. Переменные читаются только через `ConfigService<Env, true>`, не через `process.env`. Новая переменная — в схему и в `.env.example`.
- `prisma/schema.prisma` — модель данных; клиент генерируется в `src/generated/prisma` (не коммитится, не правится). Новая миграция: `npx prisma migrate dev --create-only --name <что>` → проверить SQL (дописать то, чего Prisma не выражает: CHECK, `EXCLUDE`) → `npm run db:migrate` → `npx prisma generate` (Prisma 7 не генерирует клиент сам после миграции).
- Таблицы — snake_case во множественном числе (`@@map`), колонки — snake_case (`@map`), время — `@db.Timestamptz(3)`. Значения по умолчанию задаёт база, чтобы голый SQL (сиды, ручные правки) работал так же: id — `@default(dbgenerated("uuidv7()"))` (Postgres 18), `updated_at` — `@default(now()) @updatedAt` (при UPDATE голым SQL сам не сдвигается — обновляйте его в запросе). `test/schema.int-spec.ts` проверяет, что у каждой таблицы, кроме глобальных (`businesses`, `users`, способы входа), есть `business_id NOT NULL` и что в базе нет `timestamp` без пояса: новая глобальная таблица — осознанное исключение в этом тесте (сейчас это ещё `password_logins` и `sessions`).
- У бизнеса ровно один `OWNER`, и это держит база: частичный уникальный индекс `memberships_one_owner` плюс отложенный триггер `businesses_has_owner` (проверка при коммите). Бизнес создаётся вместе с владельцем одной вложенной записью; передача владения — понизить старого и повысить нового в одной транзакции; удалить аккаунт владельца живого бизнеса нельзя.
- `Staff` — кто принимает клиентов (колонка расписания), `Membership` — кто входит и с какой ролью. Мастер без аккаунта — `Staff` без `user_id`; владелец или админ, который сам принимает, — участник со своим `Staff`. Внешний ключ `staff(user_id, business_id) → memberships(user_id, business_id)`: расписание привязывается только к участнику этого же бизнеса. Ключ `NO ACTION`, не `RESTRICT`: бизнес стирается каскадом вместе с ними, а участника с расписанием удалить нельзя, пока расписание не отвязано. Такого сервиса ещё нет: удаление участника (E3, шаг 2) и удаление аккаунта (каскад `users → memberships`) должны сначала отвязать `Staff` (`user_id = NULL`) в той же транзакции, иначе P2003 и 500.
- Способы входа — отдельные таблицы, по одной на способ (`password_logins`, позже `google_logins`), только с обязательными колонками; в `users` пароля нет. Регистрация создаёт пользователя и хотя бы один способ входа в одной транзакции. Приглашения (E3) — своя таблица, пользователь появляется только при принятии приглашения.
- `src/prisma/` — `PrismaService`, глобальный модуль.
- `src/app.setup.ts` — `configureApp()`: то, что нужно приложению сверх `AppModule` (сейчас `enableCsrfProtection()`). Вызывают и `main.ts`, и `test/test-app.ts`, чтобы тесты шли с тем же, что и прод. Настройку, которую можно выразить провайдером (`APP_PIPE`, `APP_GUARD`), кладём в `AppModule`, а не сюда.
- Очереди — `@nestjs/bullmq`, соединение уже настроено в `AppModule`; новая очередь — `BullModule.registerQueue` в своём модуле.
- Логи — `nestjs-pino`, не `console.log`. Ошибку кладём под ключ `err` (`logger.warn({ err: error }, …)`): только его pino разбирает в тип, сообщение и стек, под другим ключом `Error` выйдет в лог как `{}`.

### Вход и сессии

- `@nestjs/authentication`: глобальный guard, каждый маршрут требует входа, кроме помеченных `@Public()` (health, sign-up, sign-in, sign-out). Новый публичный маршрут — осознанное решение.
- Выход идемпотентен: 204 и стёртая кука, даже если сессия уже истекла. Регистрация, у которой аккаунт создан, а сессия не создалась, отвечает 201 без куки (фронт увидит 401 на `GET /me` и отправит на вход), а не 500.
- Сессия — HttpOnly-кука `__Host-sid` (Secure, SameSite=Lax), 30 дней максимум, 7 дней без активности. В разработке с телефона по LAN (обычный HTTP не с localhost) браузер Secure-куку не сохранит: `SESSION_COOKIE_SECURE=false` даёт `sid` без Secure; в production конфиг такое значение не пропускает. В базе (`sessions`, `src/auth/prisma-session.store.ts`) лежит SHA-256 токена, не токен. Хранилище обязано выполнять контракт пакета: `test/session-store.int-spec.ts` гоняет `authenticationStoreContract` с гонками на Postgres — менять хранилище только вместе с ним.
- Текущий пользователь — `@CurrentUser()` / `AuthenticationContext` (тип `AuthUser`, `src/auth/auth-types.ts`): id, email, name, без пароля. Хранилище читает его вместе с сессией одним запросом.
- Вход сообщает одно и то же на неверный пароль и неизвестный email, и `CredentialsService` тратит на оба одинаковое время (`PasswordHasher.verify` с пустым хэшем).
- Запросы, меняющие данные, с чужого сайта отклоняются (403) до обработчика: `enableCsrfProtection()` в `configureApp()`, плюс сам `SignInService`. Фронт ходит в API через proxy своего dev-сервера с того же origin, поэтому `trustedOrigins` не нужен; если фронт и API окажутся на разных origin, его список — в оба места. Proxy фронта не должен переписывать `Host` (`changeOrigin: true` в Vite): с телефона по LAN по обычному HTTP браузер не шлёт `Sec-Fetch-Site`, проверка сравнивает `Origin` с `Host`, и каждый POST получает 403. На localhost этого не видно.
- Лимиты — `@nestjs/throttler`, глобальный guard в `AppModule` (до guard входа, так что подобранные куки тоже считаются): `default` — по IP (100 в минуту, на входе 30 за 15 минут, на регистрации 10 в час). Лимиты по аккаунту (`src/auth/account-limits.ts`) включаются только декоратором `@CountPerAccount()` — на маршрутах, которые проверяют пароль: `account` — по email и IP (5 за 15 минут), `email` — только по email, с любых адресов (50 в час). Порог `email` высокий намеренно: кто знает адрес, может исчерпать его и на час закрыть владельцу вход по паролю.
- Лимиты считают по `req.ip`. За reverse proxy (nginx, балансировщик) задайте `TRUST_PROXY` — число прокси перед API, иначе все клиенты делят счётчики прокси. Не `true`: тогда клиент сам пишет себе IP в `X-Forwarded-For` и обнуляет лимиты.
- Счётчики в памяти процесса; общее хранилище (Redis) — с первым деплоем на несколько инстансов (E1). В тестах `createTestApp()` счётчики выключены, `createTestApp({ throttle: true })` — настоящие.

### Доступ к бизнесу

- `@nestjs/authorization`, глобальный guard после guard входа (`AuthorizationModule.forRoot()` в `AppModule` строго после `AuthenticationModule`). Он запрещает по умолчанию: обработчик без `@Can(...)`, `@Can.Anyone()` или `@Public()` отвечает 403 всем. Новый маршрут объявляет проверку явно; `@Can.Anyone()` — «любой вошедший», только для данных о самом себе (`GET /me`).
- Всё, что относится к одному бизнесу, живёт под `/businesses/:businessId/...`, и контроллер помечен `@MemberOfBusiness()` (`src/business/business.policy.ts`): `BusinessPolicy.member` пускает только участника этого бизнеса. Гость — 401, чужой бизнес, несуществующий и не-UUID — одинаковые 403: ответ не выдаёт, какие id существуют.
- Guard не заменяет фильтр: запросы сервиса всё равно идут с `businessId` (и, где читается от имени пользователя, через его членство).
- Роли — способности, не проверки в сервисах. Кто что может — одна таблица `src/business/roles.ts` (`manageStaff: ['OWNER', 'ADMIN']`); у `BusinessPolicy` на каждую способность свой метод, на маршруте — `@MayInBusiness('manageStaff')` поверх `@MemberOfBusiness()` класса. Guard проверяет класс, затем метод, поэтому чужого всё равно отклоняет `member`, а участника без права — способность.
- `@Public()` или `@Can.Anyone()` на методе снимает `@MemberOfBusiness()` его класса (так устроен `@nestjs/authorization`). Поэтому под `/businesses/:businessId` их нет; публичное (страница записи) живёт под своим префиксом, `/book/:slug`. `@MemberOfBusiness()` на маршруте без `:businessId` (`:id`) — ошибка программиста: 500 с понятным текстом в логе, не 403.
- `test/business-access.int-spec.ts` держит это машиной: обходит все маршруты приложения с `:businessId` и требует, чтобы чужого на каждом отклонила именно `BusinessPolicy.member` (по `AuthorizationEvents`; одного кода 403 мало — его отдаёт и сервис, возможно уже что-то изменив); проверяет, что чужой бизнес останавливается до обработчика, а маршрут без проверки закрыт для вошедшего.

### Связи внутри бизнеса

Когда у таблицы два родителя из одного бизнеса (запись: `business_id` + `location_id`, `staff_id`, `client_id`), база должна не дать записи одного бизнеса сослаться на филиал или мастера другого. Родитель объявляет `@@unique([businessId, id])`, ребёнок ссылается составным ключом `(business_id, location_id) → locations(business_id, id)`. Вводим с первой такой таблицей (E5–E6).

### Удаление данных

Договорённость из ревью #1, до появления сценариев удаления:

1. Бизнес из приложения не удаляется, а закрывается: отметка о закрытии, публичная страница и новые записи выключены, история остаётся. Колонку добавляем вместе с этим сценарием (вероятно, E11), не раньше.
2. Каскад от `businesses` — только для полного стирания: тесты, ручная чистка, будущая задача по сроку хранения данных.
3. Таблицы с историей (записи — E6, платежи — E10) ссылаются на клиентов и мастеров через `ON DELETE RESTRICT`: удаление мастера или клиента не должно молча стирать его прошлые записи.
4. Услуги архивируются, а не удаляются (E4).
5. Персональные данные клиента по запросу (152-ФЗ, PDPA) не «мягко удаляются», а обезличиваются — решаем в E8 вместе с юридической частью (E14).

### Ввод на границе API

- Часовой пояс бизнеса приводится в zod-схеме запроса к каноническому имени: `canonicalTimeZone` (`src/common/time-zone.ts`) берёт `resolvedOptions().timeZone` у `Intl.DateTimeFormat` (`europe/moscow` → `Europe/Moscow`) и отвергает смещения. `+03:00` Intl принимает, а Postgres читает как POSIX с обратным знаком: `AT TIME ZONE '+03:00'` уедет на 6 часов. Не `Intl.supportedValuesOf('timeZone')`: там только канонические имена, без `UTC` и старых алиасов. В базе CHECK не ставим — он зависел бы от версии tzdata на сервере.
- У каждой строки в схеме есть верхний предел длины. Слишком длинное значение — это 400 из схемы, а не 500 из уникального индекса Postgres. Пароль ограничен и в байтах после NFKC (4096): иначе `PasswordHasher.hash` бросит исключение.
- Email и slug приводятся к нижнему регистру до записи; CHECK в базе — страховка, а не основная проверка.

### Ответы об ошибках

- 400 — тело не прошло zod-схему (`StandardSchemaValidationPipe`, подключён как `APP_PIPE` в `AppModule`, а не в `main.ts`, чтобы его получал любой запуск, включая тесты): `message` — массив строк вида `business.timeZone: Unknown IANA time zone`, путь поля перед двоеточием.
- 409 — занято уникальное значение: `{ statusCode, error, message, field }`, `field` — имя поля формы. Ошибку P2002 сопоставляем по имени ограничения (`users_email_key` → `email`, хелпер `src/prisma/unique-violation.ts`), не по тексту: адаптер pg сообщает индекс, а не колонки.
- У 400 и 409 в Swagger есть схема тела (`validationErrorSchema`, `conflictErrorSchema` из `src/common/api-errors.ts`), чтобы Orval сгенерировал фронту тип `field`.
- Регистрация сообщает, что email занят: обычный компромисс ради удобства. Вход (sign-in) так не делает: на неверный email и неверный пароль один и тот же ответ.

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
