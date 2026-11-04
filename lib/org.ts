import type { SupabaseClient } from "@supabase/supabase-js";

export type Org = {
  id: string;
  role: string | null;
  displayName: string | null;
  name: string | null;
  contactLabel: string | null;
  logoUrl: string | null;
  settings: Record<string, unknown> | null;
};

// RLS pode permitir ver colegas. O vínculo/role deve ser do usuário validado,
// nunca da primeira associação visível. Não substitui as políticas do banco.
export async function getMyOrg(supabase: SupabaseClient): Promise<Org | null> {
  const { data: auth, error: authError } = await supabase.auth.getUser();
  if (authError || !auth.user) return null;

  const { data, error } = await supabase
    .from("org_members")
    .select(
      "role, display_name, org_id, organizations(id, name, contact_label, logo_url, settings)"
    )
    .eq("user_id", auth.user.id)
    .order("org_id", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error || !data) return null;
  const rel = data.organizations as unknown;
  const o = (Array.isArray(rel) ? rel[0] : rel) as Record<string, unknown> | null;
  if (!o || o.id !== data.org_id) return null;
  return {
    id: data.org_id as string,
    role: (data.role as string) ?? null,
    displayName: (data.display_name as string) ?? null,
    name: (o.name as string) ?? null,
    contactLabel: (o.contact_label as string) ?? null,
    logoUrl: (o.logo_url as string) ?? null,
    settings: (o.settings as Record<string, unknown>) ?? null,
  };
}
