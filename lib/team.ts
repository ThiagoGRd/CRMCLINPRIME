import type { SupabaseClient } from "@supabase/supabase-js";
import { FRONTS, type Front } from "./tasks";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const GENERIC = "Não foi possível adicionar o membro. Tente de novo.";

// Espelha a validação da função team-invite; o servidor é quem manda.
export function validateInvite(i: { email: string; displayName: string; front: string }): string | null {
  const email = i.email.trim();
  if (email.length > 254 || !EMAIL_RE.test(email)) return "E-mail inválido.";
  const name = i.displayName.trim();
  if (!name) return "Informe o nome.";
  if (name.length > 80) return "O nome pode ter até 80 caracteres.";
  if (!FRONTS.some((f) => f.key === i.front)) return "Frente inválida.";
  return null;
}

async function inviteError(error: unknown): Promise<string> {
  const res = (error as { context?: unknown } | null)?.context;
  if (!(res instanceof Response)) return GENERIC;
  if (res.status === 401) return "Sua sessão expirou. Entre de novo.";
  if (res.status === 403) return "Só o administrador pode adicionar membros.";
  if (res.status !== 400 && res.status !== 409) return GENERIC;
  const body = await res.json().catch(() => null);
  const text = typeof body?.error === "string" && body.error ? body.error : null;
  return text ?? (res.status === 409 ? "Esta pessoa já faz parte da equipe." : "Dados inválidos.");
}

// A organização nunca vai no corpo: a função a deduz do usuário autenticado.
export async function inviteMember(
  client: SupabaseClient,
  i: { email: string; displayName: string; front: Front; isManager: boolean },
): Promise<{ invited: boolean }> {
  const invalid = validateInvite(i);
  if (invalid) throw new Error(invalid);
  const { data, error } = await client.functions.invoke("team-invite", {
    method: "POST",
    body: { email: i.email.trim().toLowerCase(), display_name: i.displayName.trim(), front: i.front, is_manager: i.isManager },
  });
  if (error) throw new Error(await inviteError(error));
  return { invited: data?.invited !== false };
}

// Só admin altera (RLS members_admin); sem linha afetada = sem permissão.
export async function updateMember(
  client: SupabaseClient,
  i: { memberId: string; orgId: string; front: Front | null; isManager: boolean },
): Promise<void> {
  const { data, error } = await client
    .from("org_members")
    .update({ front: i.front, is_manager: i.isManager })
    .eq("id", i.memberId)
    .eq("org_id", i.orgId)
    .select("id");
  if (error || !data?.length) throw new Error("Não foi possível atualizar o membro. Tente de novo.");
}
