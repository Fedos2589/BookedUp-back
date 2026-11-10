import { execFileSync } from 'node:child_process';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
    // A database of its own for the session store contract suite (see setup()).
    sessionContractDatabaseUrl: string;
  }
}

let container: StartedPostgreSqlContainer | undefined;

// One empty Postgres for the whole run, with every migration applied — the same way
// `prisma migrate deploy` would run against a real database.
export async function setup(project: TestProject) {
  container = await new PostgreSqlContainer('postgres:18-alpine').start();
  const databaseUrl = container.getConnectionUri();

  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'pipe',
  });

  // The contract suite saves sessions with fixed times in 2023, while every sign-in in the
  // other files sweeps sessions that have expired by now: on a shared database the sweep
  // deleted the suite's sessions mid-case (seen in CI). A copy of the migrated database,
  // made before anything connects to it, keeps them apart.
  const contractDatabase = 'session_contract';
  const created = await container.exec([
    'psql',
    '-U',
    container.getUsername(),
    '-d',
    'postgres',
    '-c',
    `CREATE DATABASE ${contractDatabase} TEMPLATE ${container.getDatabase()}`,
  ]);
  if (created.exitCode !== 0) throw new Error(`Creating ${contractDatabase} failed: ${created.output}`);
  const contractUrl = new URL(databaseUrl);
  contractUrl.pathname = `/${contractDatabase}`;

  project.provide('databaseUrl', databaseUrl);
  project.provide('sessionContractDatabaseUrl', contractUrl.toString());
}

export async function teardown() {
  await container?.stop();
}
