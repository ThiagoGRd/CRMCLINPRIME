"use client";

import { useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Workflow } from "lucide-react";
import { toast } from "sonner";

type Rule = { id: string; name: string; trigger_type: string | null; is_active: boolean; runs_count: number | null };

const TRIGGER_LABEL: Record<string, string> = {
  new_contact: "Novo contato",
  stage_change: "Mudança de etapa",
  inactivity: "Inatividade",
  tag_added: "Tag adicionada",
  new_message: "Nova mensagem",
};

export function AutomacoesClient() {
  const qc = useQueryClient();
  const supabase = useMemo(() => createClient(), []);
  const { data } = useQuery({
    queryKey: ["automation-rules"],
    queryFn: async () => {
      const { data } = await supabase.from("automations").select("id,name,trigger_type,is_active,runs_count").order("created_at", { ascending: true });
      return (data ?? []) as Rule[];
    },
  });
  const rules = data ?? [];

  async function toggle(r: Rule, next: boolean) {
    const { error } = await supabase.from("automations").update({ is_active: next }).eq("id", r.id);
    if (error) toast.error("Erro ao alterar");
    else { toast.success(next ? "Automação ativada" : "Automação desativada"); qc.invalidateQueries({ queryKey: ["automation-rules"] }); }
  }

  return (
    <div className="max-w-3xl space-y-3">
      {rules.length === 0 && (
        <div className="py-10 text-center text-muted-foreground">Nenhuma automação configurada.</div>
      )}
      {rules.map((r) => (
        <Card key={r.id} className="flex flex-row items-center gap-4 p-4">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-primary">
            <Workflow className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="font-medium">{r.name}</div>
            <div className="text-xs text-muted-foreground">
              Gatilho: {TRIGGER_LABEL[r.trigger_type ?? ""] ?? r.trigger_type ?? "—"}
              {r.runs_count ? ` · ${r.runs_count} execuções` : ""}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold" style={{ color: r.is_active ? "#10b981" : undefined }}>
              {r.is_active ? "Ativa" : "Inativa"}
            </span>
            <Switch checked={r.is_active} onCheckedChange={(v) => toggle(r, v)} />
          </div>
        </Card>
      ))}
    </div>
  );
}
