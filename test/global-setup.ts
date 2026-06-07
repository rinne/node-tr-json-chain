// Provides a PostgreSQL server for the integration tests.
//
// - If TR_JSON_CHAIN_TEST_URL is set (e.g. the docker-compose database),
//   that server is used and a scratch database is created on it.
// - Otherwise a throwaway cluster is bootstrapped with initdb/pg_ctl in a
//   temp directory (requires PostgreSQL server binaries on PATH) and torn
//   down afterwards.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'pg';
import type { TestProject } from 'vitest/node';

const PORT = 54331;
const DB = 'tr_json_chain_test';

async function createScratchDb(adminUrl: string): Promise<void> {
  const client = new Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await client.query(`DROP DATABASE IF EXISTS ${DB}`);
    await client.query(`CREATE DATABASE ${DB}`);
  } finally {
    await client.end();
  }
}

export default async function setup(project: TestProject) {
  let adminUrl = process.env.TR_JSON_CHAIN_TEST_URL;
  let dataDir: string | undefined;

  if (!adminUrl) {
    dataDir = mkdtempSync(join(tmpdir(), 'tr-json-chain-test-'));
    execFileSync('initdb', ['-D', dataDir, '-U', 'postgres', '-A', 'trust', '--no-sync'], {
      stdio: 'pipe',
    });
    execFileSync(
      'pg_ctl',
      [
        '-D', dataDir,
        '-o', `-p ${PORT} -c listen_addresses=localhost -c fsync=off`,
        '-l', join(dataDir, 'server.log'),
        '-w',
        'start',
      ],
      { stdio: 'pipe' },
    );
    adminUrl = `postgres://postgres@localhost:${PORT}/postgres`;
  }

  await createScratchDb(adminUrl);
  project.provide('dbUrl', adminUrl.replace(/\/[^/]*$/, `/${DB}`));

  return async () => {
    if (dataDir) {
      execFileSync('pg_ctl', ['-D', dataDir, '-m', 'immediate', 'stop'], { stdio: 'pipe' });
      rmSync(dataDir, { recursive: true, force: true });
    }
  };
}

declare module 'vitest' {
  export interface ProvidedContext {
    dbUrl: string;
  }
}
