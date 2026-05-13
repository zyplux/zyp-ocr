const sqlFiles = import.meta.glob<string>('../../drizzle/*/migration.sql', {
  eager: true,
  import: 'default',
  query: '?raw',
});

const migrations: Record<string, string> = {};
for (const [path, sql] of Object.entries(sqlFiles)) {
  const match = /\/([^/]+)\/migration\.sql$/.exec(path);
  if (match?.[1]) migrations[match[1]] = sql;
}

export default { migrations };
