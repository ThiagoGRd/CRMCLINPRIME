"use client";

import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { useOrg } from "@/components/org-context";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Workflow, Plus, Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";

type Action = { type: string; value: string };
type Rule = {
  id: string;
  name: string;
  trigger_type: string | null;
  conditions: { raw?: string | null } | null;
  actions: Action[] | null;
  is_active: boolean;
  runs_count: number | null;
};

const TRIGGERS: { value: string; label: string }[] = [
  { value: "new_contact", label: "Novo contato chegar" },
  { value: "new_message", label: "Nova mensagem recebida" },
  { value: "stage_change", label: "Contato mudar de etapa" },
  { value: "tag_added", label: "Tag for adicionada" },
  { value: "inactivity", label: "Contato ficar inativo (24h+)" },
  { value: "appointment_created", label: "Agendamento criado" },
];
const ACTIONS: { value: string; label: string }[] = [
  { value: "send_message", label: "Enviar mensagem WhatsApp" },
  { value: "add_tag", label: "Adicionar tag" },
  { value: "move_stage", label: "Mover para etapa" },
  { value: "notify_team", label: "Notificar equipe" },
];
const label = (list: { value: string; label: string }[], v: string | null) =>
  list.find((x) => x.value === v)?.label ?? v ?? "—";

type FormState = {
  id?: string;
  name: string;
  trigger: string;
  condition: string;
  actionType: string;
  actionValue: string;
};
const EMPTY: FormState = { name: "", trigger: "new_contact", condition: "", actionType: "send_message", actionValue: "" };

export function AutomacoesClient() {
  const org = useOrg();
  const qc = useQueryClient();
  const supabase = useMemo(() => createClient(), []);
  const [form, setForm] = useState<FormState | null>(null);

  const { data } = useQuery({
    queryKey: ["automation-rules"],
    queryFn: async () => {
      const { data } = await supabase
        .from("automations")
        .select("id,name,trigger_type,conditions,actions,is_active,runs_count")
        .order("created_at", { ascending: true });
      return (data ?? []) as Rule[];
    },
  });
  const rules = data ?? [];
  const refresh = () => qc.invalidateQueries({ queryKey: ["automation-rules"] });

  async function toggle(r: Rule, next: boolean) {
    const { error } = await supabase.from("automations").update({ is_active: next }).eq("id", r.id);
    if (error) toast.error("Erro ao alterar");
    else { toast.success(next ? "Automação ativada" : "Automação desativada"); refresh(); }
  }

  async function save() {
    if (!form) return;
    if (!form.name.trim() || !form.actionValue.trim()) {
      toast.error("Preencha o nome e o conteúdo da ação");
      return;
    }
    // mesmo shape que o app antigo grava (compatível com o motor n8n)
    const payload = {
      name: form.name.trim(),
      trigger_type: form.trigger,
      conditions: { raw: form.condition.trim() || null },
      actions: [{ type: form.actionType, value: form.actionValue.trim() }],
      is_active: true,
    };
    const q = form.id
      ? supabase.from("automations").update(payload).eq("id", form.id)
      : supabase.from("automations").insert({ ...payload, org_id: org.id });
    const { error } = await q;
    if (error) toast.error("Erro ao salvar automação");
    else { toast.success("Automação salva ⚡"); setForm(null); refresh(); }
  }

  async function remove(r: Rule) {
    if (!confirm(`Excluir a automação "${r.name}"?`)) return;
    const { error } = await supabase.from("automations").delete().eq("id", r.id);
    if (error) toast.error("Erro ao excluir");
    else { toast.success("Automação excluída"); refresh(); }
  }

  function edit(r: Rule) {
    const a = (r.actions ?? [])[0];
    setForm({
      id: r.id,
      name: r.name,
      trigger: r.trigger_type ?? "new_contact",
      condition: r.conditions?.raw ?? "",
      actionType: a?.type ?? "send_message",
      actionValue: a?.value ?? "",
    });
  }

  return (
    <div className="max-w-3xl space-y-4">
      <div className="flex items-center justify-between">
        <div className="text-sm text-muted-foreground">
          Gatilho → condição → ação. As regras ativas rodam automaticamente.
        </div>
        <Button onClick={() => setForm({ ...EMPTY })}><Plus className="h-4 w-4" /> Nova automação</Button>
      </div>

      {rules.length === 0 && (
        <div className="rounded-xl border border-dashed border-border py-10 text-center text-muted-foreground">
          Nenhuma automação configurada.
        </div>
      )}
      {rules.map((r) => {
        const a = (r.actions ?? [])[0];
        return (
          <Card key={r.id} className="flex flex-row items-center gap-4 p-4">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-primary">
              <Workflow className="h-5 w-5" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="font-medium">{r.name}</div>
              <div className="truncate text-xs text-muted-foreground">
                Quando <strong>{label(TRIGGERS, r.trigger_type)}</strong>
                {r.conditions?.raw ? <> · se <em>{r.conditions.raw}</em></> : null}
                {a ? <> → {label(ACTIONS, a.type)}</> : null}
                {r.runs_count ? ` · ${r.runs_count} execuções` : ""}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <span className="text-xs font-semibold" style={{ color: r.is_active ? "#10b981" : undefined }}>
                {r.is_active ? "Ativa" : "Inativa"}
              </span>
              <Switch checked={r.is_active} onCheckedChange={(v) => toggle(r, v)} />
              <Button variant="ghost" size="icon" title="Editar" onClick={() => edit(r)}>
                <Pencil className="h-4 w-4" />
              </Button>
              <Button variant="ghost" size="icon" title="Excluir" onClick={() => remove(r)}>
                <Trash2 className="h-4 w-4 text-muted-foreground" />
              </Button>
            </div>
          </Card>
        );
      })}

      {/* Builder */}
      <Dialog open={!!form} onOpenChange={(o) => !o && setForm(null)}>
        <DialogContent className="gap-0 p-0">
          <DialogHeader className="border-b border-border px-6 py-4">
            <DialogTitle className="font-heading">{form?.id ? "Editar automação" : "Nova automação"}</DialogTitle>
          </DialogHeader>
          {form && (
            <div className="space-y-4 px-6 py-5">
              <div className="space-y-1.5">
                <Label>Nome</Label>
                <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Ex: Boas-vindas automática" />
              </div>
              <div className="space-y-1.5">
                <Label>Gatilho (quando…)</Label>
                <Select value={form.trigger} onValueChange={(v) => setForm({ ...form, trigger: v ?? form.trigger })}>
                  <SelectTrigger className="w-full"><SelectValue>{label(TRIGGERS, form.trigger)}</SelectValue></SelectTrigger>
                  <SelectContent>
                    {TRIGGERS.map((t) => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Condição (opcional)</Label>
                <Input value={form.condition} onChange={(e) => setForm({ ...form, condition: e.target.value })} placeholder='Ex: origem = "Instagram"' />
              </div>
              <div className="space-y-1.5">
                <Label>Ação (então…)</Label>
                <Select value={form.actionType} onValueChange={(v) => setForm({ ...form, actionType: v ?? form.actionType })}>
                  <SelectTrigger className="w-full"><SelectValue>{label(ACTIONS, form.actionType)}</SelectValue></SelectTrigger>
                  <SelectContent>
                    {ACTIONS.map((a) => <SelectItem key={a.value} value={a.value}>{a.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Conteúdo da ação</Label>
                <Textarea
                  rows={3}
                  value={form.actionValue}
                  onChange={(e) => setForm({ ...form, actionValue: e.target.value })}
                  placeholder={form.actionType === "send_message" ? "Olá {nome}! Bem-vindo à ClinPrime 😊" : form.actionType === "add_tag" ? "nome-da-tag" : "valor"}
                />
              </div>
            </div>
          )}
          <DialogFooter className="border-t border-border px-6 py-4">
            <Button variant="outline" onClick={() => setForm(null)}>Cancelar</Button>
            <Button onClick={save}>Salvar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
