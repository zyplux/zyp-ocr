import journal from '../../drizzle/meta/_journal.json';

const sqlFiles = import.meta.glob<string>('../../drizzle/*.sql', {
  eager: true,
  import: 'default',
  query: '?raw',
});

const migrations: Record<string, string> = {};
for (const [path, sql] of Object.entries(sqlFiles)) {
  const match = /(\d+)_.+\.sql$/.exec(path);
  if (match?.[1]) migrations[`m${match[1]}`] = sql;
}

export default { journal, migrations };
