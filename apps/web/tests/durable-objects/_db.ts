import { Database } from 'bun:sqlite';
import { drizzle, type SQLiteBunDatabase } from 'drizzle-orm/bun-sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import * as schema from '~/durable-objects/schema';

const MIGRATIONS_FOLDER = path.resolve(import.meta.dirname, '../../drizzle');

const readAllMigrationSql = () =>
  readdirSync(MIGRATIONS_FOLDER, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(d => d.name)
    .toSorted()
    .flatMap(dir =>
      readdirSync(path.join(MIGRATIONS_FOLDER, dir))
        .filter(name => name.endsWith('.sql'))
        .toSorted()
        .map(file => readFileSync(path.join(MIGRATIONS_FOLDER, dir, file), 'utf8')),
    )
    .join('\n');

const MIGRATION_SQL = readAllMigrationSql();

export type TestDb = SQLiteBunDatabase<typeof schema>;

export const createTestDb = () => {
  const client = new Database(':memory:');
  client.run(MIGRATION_SQL);
  return drizzle({ client, schema });
};
