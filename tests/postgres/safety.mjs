// Deliberately separate from application/Supabase configuration. Never load .env.
export function testDatabaseConfig(env = process.env) {
  const refuse = () => { throw new Error('Refusing non-disposable PostgreSQL target: use the documented fresh loopback test cluster and explicit opt-in.'); };
  if (env.CRM_TEST_ALLOW_DISPOSABLE_DATABASE !== '1' || !env.CRM_TEST_DATABASE_URL) refuse();
  let url;
  try { url = new URL(env.CRM_TEST_DATABASE_URL); } catch { refuse(); }
  if (!['postgresql:', 'postgres:'].includes(url.protocol) ||
      !['127.0.0.1', '[::1]'].includes(url.hostname) || url.search || url.hash ||
      url.pathname !== '/crm_concurrency_test' || url.username !== 'crm_test_owner' ||
      url.password !== 'synthetic-only' || !url.port || Number(url.port) <= 1024 || Number(url.port) === 5432) refuse();
  return {
    host: url.hostname === '[::1]' ? '::1' : url.hostname,
    port: Number(url.port), database: 'crm_concurrency_test', user: 'crm_test_owner',
    password: 'synthetic-only', ssl: false, sslnegotiation: 'postgres',
    options: '-c search_path=public', client_encoding: 'UTF8', replication: 'false',
    application_name: 'crm-synthetic-concurrency', connectionTimeoutMillis: 5000,
    statement_timeout: 10000, lock_timeout: 8000, idle_in_transaction_session_timeout: 15000,
  };
}

// Read-only checks run before the first fixture DDL. Refuse existing data rather
// than dropping schemas, roles, or tables to make the tests fit a shared server.
export async function assertFreshTestDatabase(client) {
  // Check the connected TCP peer, not inet_server_addr(): a Docker service
  // reached through a loopback-only published port sees its container address.
  if (!['127.0.0.1', '::1'].includes(client.connection.stream.remoteAddress)) {
    throw new Error('Refusing non-loopback PostgreSQL connection.');
  }
  const { rows: [identity] } = await client.query(`select current_database() as database,
    current_user as username`);
  if (identity.database !== 'crm_concurrency_test' || identity.username !== 'crm_test_owner') {
    throw new Error('Refusing non-disposable PostgreSQL server identity.');
  }
  const { rows: [state] } = await client.query(`select
    exists(select 1 from pg_namespace where nspname !~ '^pg_' and nspname not in ('public','information_schema')) or
    exists(select 1 from pg_class where relnamespace='public'::regnamespace) or
    exists(select 1 from pg_proc where pronamespace='public'::regnamespace) or
    exists(select 1 from pg_type where typnamespace='public'::regnamespace) or
    exists(select 1 from pg_extension where extname<>'plpgsql') or
    exists(select 1 from pg_publication) or
    exists(select 1 from pg_roles where rolname in ('anon','authenticated','service_role')) or
    exists(select 1 from pg_database where datname not in ('postgres','template0','template1','crm_concurrency_test')) as occupied`);
  if (state.occupied) throw new Error('Refusing occupied PostgreSQL cluster: create a fresh disposable test cluster.');
}
