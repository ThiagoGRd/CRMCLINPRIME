"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { useOrg } from "@/components/org-context";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { STAGE_FALLBACK_COLORS } from "@/lib/funil";
import { Plus, Trash2, ArrowUp, ArrowDown, Save } from "lucide-react";
import { toast } from "sonner";

type Stage = { id: string; name: string; position: number; color: string | null };
type Member = { user_id: string; role: string | null; display_name: string | null };
type FunnelFilter = { creator_ids?: string[]; include_api?: boolean; categories?: string[] };

export function ConfiguracoesClient() {
  const org = useOrg();
  const router = useRouter();
  const qc = useQueryClient();
  const supabase = useMemo(() => createClient(), []);
  const isAdmin = org.role === "admin";

  // ---------- Organização ----------
  const [orgForm, setOrgForm] = useState({
    name: org.name ?? "",
    contactLabel: org.contactLabel ?? "Paciente",
    logoUrl: org.logoUrl ?? "",
  });

  async function saveOrg() {
    const { error } = await supabase
      .from("organizations")
      .update({
        name: orgForm.name.trim() || null,
        contact_label: orgForm.contactLabel.trim() || null,
        logo_url: orgForm.logoUrl.trim() || null,
      })
      .eq("id", org.id);
    if (error) toast.error("Erro ao salvar (só admins podem alterar)");
    else { toast.success("Organização atualizada"); router.refresh(); }
  }

  // ---------- Etapas do funil ----------
  const { data: stages } = useQuery({
    queryKey: ["cfg-stages"],
    queryFn: async () => {
      const { data } = await supabase.from("pipeline_stages").select("id,name,position,color").order("position");
      return (data ?? []) as Stage[];
    },
  });
  const [newStage, setNewStage] = useState("");
  const refreshStages = () => qc.invalidateQueries({ queryKey: ["cfg-stages"] });

  async function renameStage(s: Stage, name: string) {
    if (!name.trim() || name === s.name) return;
    const { error } = await supabase.from("pipeline_stages").update({ name: name.trim() }).eq("id", s.id);
    if (error) toast.error("Erro ao renomear");
    else { toast.success("Etapa renomeada"); refreshStages(); }
  }
  async function recolorStage(s: Stage, color: string) {
    const { error } = await supabase.from("pipeline_stages").update({ color }).eq("id", s.id);
    if (error) toast.error("Erro ao alterar cor");
    else refreshStages();
  }
  async function moveStage(s: Stage, dir: -1 | 1) {
    const list = stages ?? [];
    const idx = list.findIndex((x) => x.id === s.id);
    const other = list[idx + dir];
    if (!other) return;
    await supabase.from("pipeline_stages").update({ position: other.position }).eq("id", s.id);
    await supabase.from("pipeline_stages").update({ position: s.position }).eq("id", other.id);
    refreshStages();
  }
  async function addStage() {
    const name = newStage.trim();
    if (!name) return;
    const maxPos = Math.max(0, ...(stages ?? []).map((s) => s.position));
    const { error } = await supabase
      .from("pipeline_stages")
      .insert({ name, position: maxPos + 1, color: STAGE_FALLBACK_COLORS[(stages ?? []).length % STAGE_FALLBACK_COLORS.length], org_id: org.id });
    if (error) toast.error("Erro ao criar etapa");
    else { toast.success("Etapa criada"); setNewStage(""); refreshStages(); }
  }
  async function deleteStage(s: Stage) {
    if (!confirm(`Excluir a etapa "${s.name}"? Os cards que estiverem nela voltam para a primeira etapa do funil.`)) return;
    const { error } = await supabase.from("pipeline_stages").delete().eq("id", s.id);
    if (error) toast.error("Erro ao excluir etapa");
    else { toast.success("Etapa excluída"); refreshStages(); }
  }

  // ---------- Regra do funil (CRC/Layla) ----------
  const ff = ((org.settings?.funnel_filter as FunnelFilter) ?? {}) as FunnelFilter;
  const [ruleForm, setRuleForm] = useState({
    includeApi: ff.include_api ?? true,
    creators: (ff.creator_ids ?? []).join(", "),
    categories: (ff.categories ?? []).join(", "),
  });

  async function saveRule() {
    const funnel_filter = {
      include_api: ruleForm.includeApi,
      creator_ids: ruleForm.creators.split(",").map((s) => s.trim()).filter(Boolean),
      categories: ruleForm.categories.split(",").map((s) => s.trim()).filter(Boolean),
    };
    const settings = { ...(org.settings ?? {}), funnel_filter };
    const { error } = await supabase.from("organizations").update({ settings }).eq("id", org.id);
    if (error) toast.error("Erro ao salvar regra (só admins)");
    else { toast.success("Regra do funil salva — vale a partir do próximo sync"); router.refresh(); }
  }

  // ---------- Equipe ----------
  const { data: members } = useQuery({
    queryKey: ["cfg-members"],
    queryFn: async () => {
      const { data } = await supabase.from("org_members").select("user_id,role,display_name").order("created_at");
      return (data ?? []) as Member[];
    },
  });

  async function renameMember(m: Member, name: string) {
    if (!name.trim() || name === m.display_name) return;
    const { error } = await supabase.from("org_members").update({ display_name: name.trim() }).eq("user_id", m.user_id).eq("org_id", org.id);
    if (error) toast.error("Erro ao renomear (só admins)");
    else { toast.success("Membro atualizado"); qc.invalidateQueries({ queryKey: ["cfg-members"] }); }
  }

  return (
    <div className="max-w-3xl space-y-6">
      {/* Organização */}
      <Card className="gap-4 p-6">
        <div>
          <div className="font-heading text-base font-bold">Organização</div>
          <div className="text-sm text-muted-foreground">Identidade da clínica no CRM.</div>
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>Nome</Label>
            <Input value={orgForm.name} onChange={(e) => setOrgForm({ ...orgForm, name: e.target.value })} />
          </div>
          <div className="space-y-1.5">
            <Label>Como chamar o contato</Label>
            <Input value={orgForm.contactLabel} onChange={(e) => setOrgForm({ ...orgForm, contactLabel: e.target.value })} placeholder="Paciente, Lead, Cliente..." />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label>URL do logo (opcional)</Label>
            <Input value={orgForm.logoUrl} onChange={(e) => setOrgForm({ ...orgForm, logoUrl: e.target.value })} placeholder="https://..." />
          </div>
        </div>
        <div className="flex justify-end">
          <Button onClick={saveOrg} disabled={!isAdmin} title={isAdmin ? "" : "Somente admins"}>
            <Save className="h-4 w-4" /> Salvar
          </Button>
        </div>
      </Card>

      {/* Etapas do funil */}
      <Card className="gap-4 p-6">
        <div>
          <div className="font-heading text-base font-bold">Etapas do funil</div>
          <div className="text-sm text-muted-foreground">Renomeie, reordene, mude a cor ou crie novas etapas do kanban.</div>
        </div>
        <div className="space-y-2">
          {(stages ?? []).map((s, i) => (
            <div key={s.id} className="flex items-center gap-2 rounded-lg bg-bg-tertiary p-2.5">
              <input
                type="color"
                defaultValue={s.color ?? "#6366f1"}
                onBlur={(e) => e.target.value !== (s.color ?? "#6366f1") && recolorStage(s, e.target.value)}
                className="h-7 w-8 shrink-0 cursor-pointer rounded border-0 bg-transparent"
                title="Cor da etapa"
              />
              <Input
                defaultValue={s.name}
                onBlur={(e) => renameStage(s, e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                className="h-8"
              />
              <Button variant="ghost" size="icon" disabled={i === 0} onClick={() => moveStage(s, -1)} title="Subir">
                <ArrowUp className="h-4 w-4" />
              </Button>
              <Button variant="ghost" size="icon" disabled={i === (stages ?? []).length - 1} onClick={() => moveStage(s, 1)} title="Descer">
                <ArrowDown className="h-4 w-4" />
              </Button>
              <Button variant="ghost" size="icon" onClick={() => deleteStage(s)} title="Excluir etapa">
                <Trash2 className="h-4 w-4 text-muted-foreground" />
              </Button>
            </div>
          ))}
        </div>
        <div className="flex gap-2">
          <Input
            value={newStage}
            onChange={(e) => setNewStage(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addStage(); } }}
            placeholder="Nova etapa..."
            className="h-9"
          />
          <Button onClick={addStage}><Plus className="h-4 w-4" /> Adicionar</Button>
        </div>
      </Card>

      {/* Regra do funil (CRC) */}
      <Card className="gap-4 p-6">
        <div>
          <div className="font-heading text-base font-bold">Regra do funil (CRC)</div>
          <div className="text-sm text-muted-foreground">
            Define quais agendamentos do Clinicorp contam como funil de marketing (agendamentos/comparecimentos das Metas).
          </div>
        </div>
        <label className="flex items-center justify-between rounded-lg bg-bg-tertiary p-3">
          <div>
            <div className="text-sm font-medium">Contar agendamentos criados via API</div>
            <div className="text-xs text-muted-foreground">O app CRC agenda via API — mantém ligado para contar o trabalho da equipe CRC.</div>
          </div>
          <Switch checked={ruleForm.includeApi} onCheckedChange={(v) => setRuleForm({ ...ruleForm, includeApi: v })} />
        </label>
        <div className="space-y-1.5">
          <Label>IDs dos usuários do Clinicorp que contam (separados por vírgula)</Label>
          <Input value={ruleForm.creators} onChange={(e) => setRuleForm({ ...ruleForm, creators: e.target.value })} placeholder="4895808292913153" />
          <div className="text-xs text-muted-foreground">Hoje: Layla Ventura (4895808292913153).</div>
        </div>
        <div className="space-y-1.5">
          <Label>Categorias de agendamento que contam (separadas por vírgula)</Label>
          <Input value={ruleForm.categories} onChange={(e) => setRuleForm({ ...ruleForm, categories: e.target.value })} placeholder="AVALIAÇÃO MARKETING, Nova avaliação de paciente" />
        </div>
        <div className="flex justify-end">
          <Button onClick={saveRule} disabled={!isAdmin} title={isAdmin ? "" : "Somente admins"}>
            <Save className="h-4 w-4" /> Salvar regra
          </Button>
        </div>
      </Card>

      {/* Equipe */}
      <Card className="gap-4 p-6">
        <div>
          <div className="font-heading text-base font-bold">Equipe</div>
          <div className="text-sm text-muted-foreground">
            Membros da organização. Para convidar novos membros, crie o login no Supabase Auth (em breve: convite por e-mail).
          </div>
        </div>
        <div className="space-y-2">
          {(members ?? []).map((m) => (
            <div key={m.user_id} className="flex items-center gap-3 rounded-lg bg-bg-tertiary p-2.5">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-primary to-emerald-500 text-[11px] font-bold text-white">
                {(m.display_name ?? "?").slice(0, 2).toUpperCase()}
              </div>
              <Input
                defaultValue={m.display_name ?? ""}
                onBlur={(e) => renameMember(m, e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                className="h-8"
                disabled={!isAdmin}
              />
              <Badge variant={m.role === "admin" ? "default" : "secondary"}>{m.role ?? "membro"}</Badge>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
