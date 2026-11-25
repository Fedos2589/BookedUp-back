import { execFileSync } from 'node:child_process';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
    // A database of its own for the session store contract suite (see setup()).
    sessionContractDatabaseUrl: string;
    // A database of its own for the dispatcher suite (see setup()).
    dispatchDatabaseUrl: string;
  }
}

let container: StartedPostgreSqlContainer | undefined;

// One empty Postgres for the whole run, with every migration applied — the same way
// `prisma migrate deploy` would run against a real database.
export async function setup(project: TestProject) {
  const started = await new PostgreSqlContainer('postgres:18-alpine').start();
  container = started;
  const databaseUrl = started.getConnectionUri();

  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'pipe',
  });

  // Two suites get a database of their own, a copy of the migrated one made before anything connects to it:
  // - the session contract suite saves sessions with fixed times in 2023, while every sign-in in the other
  //   files sweeps sessions that have expired by now: on a shared database the sweep deleted the suite's
  //   sessions mid-case (seen in CI);
  // - the dispatcher suite looks at what its own dispatch sent, while any other file that dispatches takes
  //   its deliveries too (the outbox is one queue for all businesses): a delivery sent by someone else's
  //   run is not in this file's mock, and is still SENDING when this file looks (flaky in CI).
  const databaseNamed = async (name: string) => {
    const created = await started.exec([
      'psql',
      '-U',
      started.getUsername(),
      '-d',
      'postgres',
      '-c',
      `CREATE DATABASE ${name} TEMPLATE ${started.getDatabase()}`,
    ]);
    if (created.exitCode !== 0) throw new Error(`Creating ${name} failed: ${created.output}`);
    const url = new URL(databaseUrl);
    url.pathname = `/${name}`;
    return url.toString();
  };

  project.provide('databaseUrl', databaseUrl);
  project.provide('sessionContractDatabaseUrl', await databaseNamed('session_contract'));
  project.provide('dispatchDatabaseUrl', await databaseNamed('dispatch'));
}

export async function teardown() {
  await container?.stop();
}
