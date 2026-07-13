import { createClient } from "@/lib/supabase/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Lead, Stage } from "@/lib/funil";
import { FunilBoard } from "@/components/funil/funil-board";

async function fetchAllPatients(supabase: SupabaseClient): Promise<Lead[]> {
  const pageSize = 1000;
  let offset = 0;
  const all: Lead[] = [];
  // paginação (supera o teto de 1000 do PostgREST)
  for (let guard = 0; guard < 20; guard++) {
    const { data, error } = await supabase
      .from("patients")
      .select(
        "id,name,phone,source,treatment_interest,channel,notes,tags,created_at,clinicorp_status,clinicorp_amount,clinicorp_est_count,deal:deals(id,stage_id)"
      )
      .order("created_at", { ascending: false })
      .range(offset, offset + pageSize - 1);
    if (error || !data) break;
    for (const p of data as Record<string, unknown>[]) {
      const deal = Array.isArray(p.deal) ? p.deal[0] : p.deal;
      all.push({
        id: p.id as string,
        name: (p.name as string) ?? "Sem nome",
        phone: (p.phone as string) ?? "",
        source: (p.treatment_interest as string) || (p.source as string) || "Geral",
        channel: (p.channel as string) ?? null,
        notes: (p.notes as string) ?? null,
        tags: (p.tags as string[]) ?? [],
        createdAt: (p.created_at as string) ?? null,
        stageId: (deal?.stage_id as string) ?? null,
        dealId: (deal?.id as string) ?? null,
        ccStatus: (p.clinicorp_status as string) ?? null,
        ccAmount: parseFloat((p.clinicorp_amount as string) ?? "0") || 0,
        ccCount: (p.clinicorp_est_count as number) ?? 0,
      });
    }
    if (data.length < pageSize) break;
    offset += pageSize;
  }
  return all;
}

export default async function FunilPage() {
  const supabase = await createClient();
  const [{ data: stagesRaw }, leads] = await Promise.all([
    supabase.from("pipeline_stages").select("id,name,position,color").order("position"),
    fetchAllPatients(supabase),
  ]);
  const stages = (stagesRaw ?? []) as Stage[];

  return <FunilBoard stages={stages} initialLeads={leads} />;
}
