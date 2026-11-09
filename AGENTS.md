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

1. **Мультиарендность.** У каждой таблицы с данными бизнеса есть `businessId`, и каждый запрос фильтруется по нему. Доступ проверяет guard, а не каждый сервис по-своему. Запрос без `businessId` в `where` к такой таблице — баг.
2. **Время.** В базе всё в UTC (`timestamptz`). У `Business` свой часовой пояс (IANA, `Europe/Moscow`), слоты и рабочие часы считаются в нём. Не использовать часовой пояс сервера.
3. **Двойная запись невозможна на уровне Postgres.** На записи мастера — ограничение `EXCLUDE USING gist` по диапазону времени (`tstzrange`) для `staffId` (расширение `btree_gist`). Prisma этого не выражает — ограничение пишется SQL-ом в миграции. Проверка в коде — только для понятной ошибки, не вместо ограничения.

### Что где

- `src/config/env.ts` — env, проверяется zod при старте. Переменные читаются только через `ConfigService<Env, true>`, не через `process.env`. Новая переменная — в схему и в `.env.example`.
- `prisma/schema.prisma` — модель данных; клиент генерируется в `src/generated/prisma` (не коммитится, не правится). Новая миграция: `npx prisma migrate dev --create-only --name <что>` → проверить SQL (дописать то, чего Prisma не выражает: CHECK, `EXCLUDE`) → `npm run db:migrate` → `npx prisma generate` (Prisma 7 не генерирует клиент сам после миграции).
- Таблицы — snake_case во множественном числе (`@@map`), колонки — snake_case (`@map`), id — `uuid(7)`, время — `@db.Timestamptz(3)`. `test/schema.int-spec.ts` проверяет, что у каждой таблицы, кроме глобальных `businesses` и `users`, есть `business_id NOT NULL` и что в базе нет `timestamp` без пояса: новая глобальная таблица — осознанное исключение в этом тесте.
- `src/prisma/` — `PrismaService`, глобальный модуль.
- Очереди — `@nestjs/bullmq`, соединение уже настроено в `AppModule`; новая очередь — `BullModule.registerQueue` в своём модуле.
- Логи — `nestjs-pino`, не `console.log`.

### Проверки

Перед каждым коммитом:

```bash
npm run typecheck
npm run lint
npm test
npm run test:e2e
npm run test:int   # нужен запущенный Docker
npm run build
```

Postgres и Redis локально — `docker compose up -d`.
