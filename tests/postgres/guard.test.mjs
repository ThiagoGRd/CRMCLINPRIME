import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { testDatabaseConfig } from './safety.mjs';

const url = 'postgresql://crm_test_owner:synthetic-only@127.0.0.1:55439/crm_concurrency_test';
const env = { CRM_TEST_DATABASE_URL: url, CRM_TEST_ALLOW_DISPOSABLE_DATABASE: '1' };

test('PostgreSQL fixture requires explicit opt-in and never falls back to deployment variables', () => {
  for (const input of [{}, { DATABASE_URL: url, PGHOST: '127.0.0.1' },
    { CRM_TEST_DATABASE_URL: url }, { ...env, CRM_TEST_ALLOW_DISPOSABLE_DATABASE: 'true' }]) {
    assert.throws(() => testDatabaseConfig(input), /disposable PostgreSQL/i);
  }
});

test('PostgreSQL fixture accepts only literal loopback and explicit disposable identity', () => {
  assert.equal(testDatabaseConfig(env).host, '127.0.0.1');
  assert.equal(testDatabaseConfig(env).database, 'crm_concurrency_test');
  assert.equal(testDatabaseConfig(env).user, 'crm_test_owner');
  assert.equal(testDatabaseConfig(env).port, 55439);
  assert.equal(testDatabaseConfig({ ...env, CRM_TEST_DATABASE_URL: url.replace('127.0.0.1', '[::1]') }).host, '::1');
  for (const candidate of [
    url.replace('127.0.0.1', 'db.example.com'),
    url.replace('127.0.0.1', 'localhost'),
    url.replace('127.0.0.1', '127.0.0.2'),
    url.replace('127.0.0.1', '127.1'),
    url.replace('127.0.0.1', '0.0.0.0'),
    url.replace('127.0.0.1', '[::ffff:127.0.0.1]'),
    url.replace(':55439', ''),
    url.replace(':55439', ':5432'),
    url.replace(':55439', ':80'),
    url.replace('crm_test_owner', 'postgres'),
    url.replace('synthetic-only', 'real-secret'),
    url.replace('/crm_concurrency_test', '/postgres'),
    url.replace('/crm_concurrency_test', '/crm_concurrency_test/other'),
    url.replace('postgresql:', 'https:'),
    `${url}?host=db.example.com`,
    `${url}?sslmode=disable`,
    `${url}#anything`,
    'not a URL',
  ]) assert.throws(() => testDatabaseConfig({ ...env, CRM_TEST_DATABASE_URL: candidate }), /disposable PostgreSQL/i);
});

test('actual PostgreSQL client ignores ambient credentials, TLS handshake and startup options', () => {
  // A plain config assertion misses pg's truthy fallback (options: '' still
  // inherits PGOPTIONS). Construct the real client in an isolated process.
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { Client } from 'pg';
    import { testDatabaseConfig } from '${new URL('./safety.mjs', import.meta.url)}';
    const client = new Client(testDatabaseConfig());
    const p = client.connectionParameters;
    console.log(JSON.stringify({ host:p.host, port:p.port, user:p.user, database:p.database,
      password:client.password, ssl:p.ssl, options:p.options, sslnegotiation:p.sslnegotiation,
      encoding:p.client_encoding, replication:p.replication,
      connectionTimeout:client._connectionTimeoutMillis, statementTimeout:p.statement_timeout,
      idleTimeout:p.idle_in_transaction_session_timeout }));
  `], { encoding: 'utf8', cwd: new URL('../../', import.meta.url), env: {
    ...env, PGHOST: 'production.invalid', PGPORT: '5432', PGUSER: 'production',
    PGPASSWORD: 'do-not-use', PGDATABASE: 'production', PGSSLMODE: 'require',
    PGSSLNEGOTIATION: 'direct', PGOPTIONS: '-c search_path=other',
    PGCLIENT_ENCODING: 'LATIN1', PGREPLICATION: 'database',
  } });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), {
    host: '127.0.0.1', port: 55439, user: 'crm_test_owner', database: 'crm_concurrency_test',
    password: 'synthetic-only', ssl: false, options: '-c search_path=public',
    sslnegotiation: 'postgres', encoding: 'UTF8', replication: 'false',
    connectionTimeout: 5000, statementTimeout: 10000, idleTimeout: 15000,
  });
});
