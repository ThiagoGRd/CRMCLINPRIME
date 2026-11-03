// Test-only adapter: preserve the actual Supabase request builder/HTTP transport.
// Authentication is a synthetic, non-persisted identity. It cannot access a real project.
import type { Session, SupabaseClient } from '@supabase/supabase-js';
import { createClient as createRealClient } from '../../lib/supabase/client';

let client: SupabaseClient | undefined;
export function createClient(): SupabaseClient {
  if (client) return client;
  client = createRealClient();
  const session: Session = {
    access_token:'synthetic-fixture-token-not-a-credential',
    refresh_token:'synthetic-fixture-refresh-not-a-credential',
    expires_in:86400,
    expires_at:Math.floor(Date.now()/1000)+86400,
    token_type:'bearer',
    user:{
      id:'00000000-0000-4000-8000-000000000011',
      aud:'authenticated',role:'authenticated',
      app_metadata:{},user_metadata:{},
      created_at:'2026-11-01T10:00:00Z',
    },
  };
  client.auth.getSession = async () => ({data:{session},error:null});
  return client;
}
