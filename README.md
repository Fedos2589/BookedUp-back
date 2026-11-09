# BookedUp — back

API на NestJS + TypeScript, PostgreSQL через Prisma, очереди на Redis + BullMQ. Swagger отдаётся на `/api/docs` (JSON — `/api/docs-json`), из него фронт генерирует клиент через Orval.

| Задача | Инструмент |
| --- | --- |
| Основа | NestJS 12 (ESM) |
| База | PostgreSQL + Prisma 7 (`prisma/schema.prisma`, клиент в `src/generated/prisma`) |
| Очереди | Redis + BullMQ (`@nestjs/bullmq`) — соединение настроено, очередей пока нет |
| API | `@nestjs/swagger` |
| Конфиг | `@nestjs/config`, env проверяется zod при старте (`src/config/env.ts`) |
| Логи | pino (`nestjs-pino`) |
| Тесты | Vitest + supertest |

```bash
cp .env.example .env
npm install              # заодно генерирует Prisma Client
docker compose up -d     # Postgres и Redis
npm run start:dev        # http://localhost:3000/health, http://localhost:3000/api/docs
npm run build
npm run typecheck
npm run lint
npm test
npm run test:e2e
npm run db:migrate       # после появления моделей

docker compose --profile api up --build   # API тоже в контейнере
```

Приложение стартует и без базы: Prisma подключается при первом запросе.
