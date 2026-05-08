import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'sqlite',
  driver: 'durable-sqlite',
  out: './drizzle',
  schema: './src/durable-objects/schema.ts',
});
