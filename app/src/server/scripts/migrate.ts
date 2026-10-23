// app/src/server/scripts/migrate.ts

import 'dotenv/config';
import { spawn } from 'node:child_process';

const direction = process.argv[2];
const databaseUrl = process.env.DATABASE_URL;

if (direction !== 'up' && direction !== 'down') {
  throw new Error('Expected migration direction: up or down');
}

if (!databaseUrl) {
  throw new Error('DATABASE_URL is missing');
}

const child = spawn(process.execPath, [
  '--import',
  'tsx',
  './node_modules/node-pg-migrate/bin/node-pg-migrate',
  direction,
  '--migrations-dir',
  'src/server/db/migrations',
  '--database-url',
  databaseUrl,
], {
  stdio: 'inherit',
  env: process.env,
});

child.on('error', (error) => {
  console.error('Failed to launch migrations', error);
  process.exitCode = 1;
});

child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`Migration process terminated by ${signal}`);
    process.exitCode = 1;
  } else {
    process.exitCode = code ?? 1;
  }
});
