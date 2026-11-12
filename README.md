# BookedUp — back

An API on NestJS + TypeScript, PostgreSQL through Prisma, queues on Redis + BullMQ. Swagger is served at `/api/docs` (JSON — `/api/docs-json`); the front generates its client from it with Orval.

| Task   | Tool                                                                             |
| ------ | -------------------------------------------------------------------------------- |
| Core   | NestJS 12 (ESM)                                                                  |
| DB     | PostgreSQL + Prisma 7 (`prisma/schema.prisma`, client in `src/generated/prisma`) |
| Queues | Redis + BullMQ (`@nestjs/bullmq`) — the connection is set up, no queues yet      |
| API    | `@nestjs/swagger`                                                                |
| Config | `@nestjs/config`, env validated by zod at startup (`src/config/env.ts`)          |
| Logs   | pino (`nestjs-pino`)                                                             |
| Tests  | Vitest + supertest                                                               |

```bash
cp .env.example .env
npm install              # also generates the Prisma Client
docker compose up -d     # Postgres and Redis
npm run start:dev        # http://localhost:3000/health, http://localhost:3000/api/docs
npm run build
npm run typecheck
npm run lint
npm test
npm run test:e2e
npm run test:int         # integration tests on their own Postgres in Docker (Testcontainers)
npm run db:migrate       # apply migrations to the local database

docker compose --profile api up --build   # the API in a container too
```

The app starts without a database too: Prisma connects on the first request.
