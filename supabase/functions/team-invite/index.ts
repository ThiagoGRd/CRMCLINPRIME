import { createClient } from 'jsr:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
function json(b: unknown, s = 200) {
  return new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });
}

const FRONTS = ['recepcao', 'crc_leads', 'comercial', 'pos_venda'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Método não permitido.' }, 405);

  const url = Deno.env.get('SUPABASE_URL')!;
  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return json({ error: 'Não autenticado.' }, 401);

  // 1) Quem chama: cliente de chave anônima com o JWT do pedido.
  const caller = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: auth, error: authError } = await caller.auth.getUser();
  if (authError || !auth.user) return json({ error: 'Não autenticado.' }, 401);

  // 2) Papel e organização vêm só da linha do chamador, nunca do corpo.
  const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: me, error: meError } = await admin
    .from('org_members')
    .select('org_id, role')
    .eq('user_id', auth.user.id)
    .order('org_id', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (meError) return json({ error: 'Não foi possível verificar a permissão.' }, 500);
  if (!me || me.role !== 'admin') return json({ error: 'Só o administrador pode adicionar membros.' }, 403);
  const orgId = me.org_id as string;

  // 3) Validação.
  let body: Record<string, unknown>;
  try {
    const parsed = await req.json();
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('shape');
    body = parsed as Record<string, unknown>;
  } catch {
    return json({ error: 'Corpo inválido.' }, 400);
  }
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (email.length > 254 || !EMAIL_RE.test(email)) return json({ error: 'E-mail inválido.' }, 400);
  const displayName = typeof body.display_name === 'string' ? body.display_name.trim() : '';
  if (displayName.length < 1) return json({ error: 'Informe o nome.' }, 400);
  if (displayName.length > 80) return json({ error: 'O nome pode ter até 80 caracteres.' }, 400);
  if (typeof body.front !== 'string' || !FRONTS.includes(body.front)) return json({ error: 'Frente inválida.' }, 400);
  if (body.is_manager !== undefined && typeof body.is_manager !== 'boolean') return json({ error: 'Gestor inválido.' }, 400);
  const isManager = body.is_manager === true;

  // 4) Convite. "Conta já existe" é detectado pelo código do erro; qualquer outra falha é 502.
  let userId: string | null = null;
  let invited = false;
  const { data: inv, error: invError } = await admin.auth.admin.inviteUserByEmail(email);
  if (!invError && inv.user) {
    userId = inv.user.id;
    invited = true;
  } else {
    const e = invError as { code?: string; status?: number } | null;
    if (!e || (e.code !== 'email_exists' && e.status !== 422)) {
      return json({ error: 'Não foi possível enviar o convite.' }, 502);
    }
    // shortcut: varre listUsers (sem filtro por e-mail na API), até 20 páginas de 1000; subir se passar disso.
    for (let page = 1; page <= 20 && !userId; page++) {
      const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
      if (error) break;
      userId = data.users.find((u) => u.email?.toLowerCase() === email)?.id ?? null;
      if (data.users.length < 1000) break;
    }
    if (!userId) return json({ error: 'Não foi possível enviar o convite.' }, 502);
  }

  // 5) Vínculos do usuário, nos dois caminhos: esta organização -> 409; outra -> 409; nenhum (órfão) -> segue.
  const { data: rows, error: rowsError } = await admin
    .from('org_members').select('org_id').eq('user_id', userId);
  if (rowsError) return json({ error: 'Não foi possível verificar a equipe.' }, 500);
  if (rows?.some((r) => r.org_id === orgId)) return json({ error: 'Esta pessoa já faz parte da equipe.' }, 409);
  if (rows && rows.length > 0) return json({ error: 'Este e-mail já pertence a outra organização.' }, 409);

  const { error: insError } = await admin.from('org_members').insert({
    org_id: orgId, user_id: userId, role: 'member', display_name: displayName, front: body.front, is_manager: isManager,
  });
  if (insError) {
    if (insError.code === '23505') return json({ error: 'Esta pessoa já faz parte da equipe.' }, 409);
    return json({
      error: invited
        ? 'Convite enviado, mas não foi possível registrar o membro na equipe.'
        : 'Não foi possível registrar o membro na equipe.',
    }, 500);
  }
  return json({ ok: true, user_id: userId, invited });
});
