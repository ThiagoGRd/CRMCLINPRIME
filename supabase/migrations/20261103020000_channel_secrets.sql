-- Token de acesso de cada número conectado via Embedded Signup.
-- Tabela separada com RLS sem policies: só as edge functions (service role) leem; o front nunca vê o token.
CREATE TABLE IF NOT EXISTS public.channel_secrets (
  channel_id uuid PRIMARY KEY REFERENCES public.channels(id) ON DELETE CASCADE,
  access_token text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.channel_secrets ENABLE ROW LEVEL SECURITY;
