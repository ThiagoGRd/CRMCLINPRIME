"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { useOrg } from "@/components/org-context";
import { formatCurrency, formatPhoneDisplay, formatDateBR } from "@/lib/format";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { MessageSquare } from "lucide-react";
import { toast } from "sonner";

const CC_SHORT: Record<string, { txt: string; color: string }> = {
  OPEN: { txt: "Em aberto", color: "#3b82f6" },
  FOLLOWUP: { txt: "Follow-up", color: "#f59e0b" },
};
const SIT: Record<string, { txt: string; color: string }> = {
  active: { txt: "Na cadência", color: "#3b82f6" },
  responded: { txt: "Respondeu", color: "#10b981" },
  rescheduled: { txt: "Reagendou", color: "#10b981" },
  completed: { txt: "Concluída", color: "#94a3b8" },
  paused_human: { txt: "Humano assumiu", color: "#94a3b8" },
  stopped: { txt: "Parada", color: "#94a3b8" },
};

type Budget = { id: string; name: string; phone: string | null; clinicorp_status: string | null; clinicorp_amount: number | null; clinicorp_date: string | null };
type NoShow = { patient_name: string | null; phone: string | null; appt_date: string | null; category: string | null };
type Enrollment = { id: string; patient_name: string | null; phone: string; current_step: number; next_send_at: string | null; status: string };
type Cadence = { id: string; active: boolean; steps: { step: number; message: string }[] };

export function FollowupClient() {
  const org = useOrg();
  const router = useRouter();
  const qc = useQueryClient();
  const supabase = useMemo(() => createClient(), []);

  async function atenderByPhone(phone: string | null) {
    const d = String(phone ?? "").replace(/\D/g, "");
    if (!d) return;
    const { data } = await supabase.from("patients").select("id").ilike("phone", `%${d.slice(-8)}`).limit(1).maybeSingle();
    if (data?.id) router.push(`/inbox?p=${data.id}`);
    else toast.error("Paciente não encontrado no CRM");
  }

  return (
    <Tabs defaultValue="orcamentos">
      <TabsList>
        <TabsTrigger value="orcamentos">Orçamentos em aberto</TabsTrigger>
        <TabsTrigger value="faltas">Cadência de faltas</TabsTrigger>
      </TabsList>

      <TabsContent value="orcamentos" className="mt-5">
        <OpenBudgets supabase={supabase} orgId={org.id} onAtender={(id) => router.push(`/inbox?p=${id}`)} />
      </TabsContent>

      <TabsContent value="faltas" className="mt-5">
        <CadencePanel supabase={supabase} orgId={org.id} qc={qc} atenderByPhone={atenderByPhone} />
      </TabsContent>
    </Tabs>
  );
}

function Stat({ label, value, color }: { label: string; value: React.ReactNode; color?: string }) {
  return (
    <Card className="min-w-[150px] gap-0 p-4">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1.5 font-heading text-xl font-extrabold" style={{ color }}>{value}</div>
    </Card>
  );
}

function OpenBudgets({ supabase, orgId, onAtender }: { supabase: ReturnType<typeof createClient>; orgId: string; onAtender: (id: string) => void }) {
  const { data } = useQuery({
    queryKey: ["open-budgets"],
    queryFn: async () => {
      const { data } = await supabase
        .from("patients")
        .select("id,name,phone,clinicorp_status,clinicorp_amount,clinicorp_date")
        .in("clinicorp_status", ["OPEN", "FOLLOWUP"])
        .order("clinicorp_amount", { ascending: false, nullsFirst: false })
        .limit(1000);
      return (data ?? []) as Budget[];
    },
  });
  const rows = data ?? [];
  const total = rows.reduce((a, r) => a + (r.clinicorp_amount ?? 0), 0);
  const nFup = rows.filter((r) => r.clinicorp_status === "FOLLOWUP").length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-4">
        <Stat label="Pacientes com orçamento aberto" value={rows.length} />
        <Stat label="Valor total em jogo" value={formatCurrency(total)} color="#10b981" />
        <Stat label="Em follow-up" value={nFup} color="#f59e0b" />
      </div>
      <div className="overflow-x-auto rounded-xl border border-border bg-card">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-muted-foreground">
              <th className="px-4 py-3 font-semibold">Paciente</th>
              <th className="px-4 py-3 font-semibold">Status</th>
              <th className="px-4 py-3 font-semibold">Valor</th>
              <th className="px-4 py-3 font-semibold">Data</th>
              <th className="px-4 py-3 font-semibold text-right">Ação</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">Nenhum orçamento em aberto 🎉</td></tr>}
            {rows.map((r) => {
              const st = r.clinicorp_status ? CC_SHORT[r.clinicorp_status] : null;
              return (
                <tr key={r.id} className="border-b border-white/[.04] last:border-0 hover:bg-white/[.02]">
                  <td className="px-4 py-3 font-medium">{r.name}</td>
                  <td className="px-4 py-3"><span style={{ color: st?.color }} className="font-semibold">{st?.txt ?? "—"}</span></td>
                  <td className="px-4 py-3 font-bold text-emerald-400">{formatCurrency(r.clinicorp_amount ?? 0)}</td>
                  <td className="px-4 py-3 text-muted-foreground">{formatDateBR(r.clinicorp_date)}</td>
                  <td className="px-4 py-3 text-right">
                    <Button size="sm" onClick={() => onAtender(r.id)}><MessageSquare className="h-3.5 w-3.5" /> Atender</Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function CadencePanel({ supabase, orgId, qc, atenderByPhone }: {
  supabase: ReturnType<typeof createClient>; orgId: string; qc: ReturnType<typeof useQueryClient>; atenderByPhone: (p: string | null) => void;
}) {
  const [msgs, setMsgs] = useState<string[] | null>(null);

  const { data: cad } = useQuery({
    queryKey: ["cadence"],
    queryFn: async () => {
      const { data } = await supabase.from("crm_cadences").select("id,active,steps").eq("org_id", orgId).eq("key", "resgate_falta").maybeSingle();
      return (data ?? null) as Cadence | null;
    },
  });
  const { data: enrollments } = useQuery({
    queryKey: ["cad-enrollments"],
    queryFn: async () => {
      const { data } = await supabase.from("crm_cadence_enrollments").select("id,patient_name,phone,current_step,next_send_at,status").eq("org_id", orgId).order("created_at", { ascending: false }).limit(500);
      return (data ?? []) as Enrollment[];
    },
  });
  const { data: noShows } = useQuery({
    queryKey: ["no-shows"],
    queryFn: async () => {
      const { data } = await supabase.from("crm_attendances").select("patient_name,phone,appt_date,category").eq("status", "faltou").eq("in_funnel", true).order("appt_date", { ascending: false }).limit(1000);
      // dedup por telefone (últimos 8)
      const seen = new Set<string>(); const out: NoShow[] = [];
      for (const r of (data ?? []) as NoShow[]) {
        const k = String(r.phone ?? "").replace(/\D/g, "").slice(-8);
        if (!k || seen.has(k)) continue; seen.add(k); out.push(r);
      }
      return out;
    },
  });

  const steps = (cad?.steps ?? []).slice().sort((a, b) => a.step - b.step);
  const editMsgs = msgs ?? steps.map((s) => s.message);
  const enr = enrollments ?? [];
  const byStatus = enr.reduce<Record<string, number>>((m, e) => { m[e.status] = (m[e.status] ?? 0) + 1; return m; }, {});
  const enrByPhone = new Map(enr.map((e) => [String(e.phone).replace(/\D/g, "").slice(-8), e.status]));
  const rotulo = ["1º toque (mesmo dia)", "2º toque (+2 dias)", "3º toque (+5 dias)", "4º toque (+10 dias)"];

  async function toggle(next: boolean) {
    if (!cad) return;
    if (next && !confirm("Ligar a cadência? A Layla passará a enviar mensagens automáticas (WhatsApp real) para quem faltou, das 9h às 18h.")) return;
    const { error } = await supabase.from("crm_cadences").update({ active: next }).eq("id", cad.id);
    if (error) toast.error("Erro ao alterar");
    else { toast.success(next ? "Cadência ligada ✅" : "Cadência desligada"); qc.invalidateQueries({ queryKey: ["cadence"] }); }
  }
  async function saveMsgs() {
    if (!cad) return;
    const newSteps = steps.map((s, i) => ({ ...s, message: editMsgs[i] ?? s.message }));
    const { error } = await supabase.from("crm_cadences").update({ steps: newSteps }).eq("id", cad.id);
    if (error) toast.error("Erro ao salvar mensagens");
    else { toast.success("Mensagens salvas ✅"); setMsgs(null); qc.invalidateQueries({ queryKey: ["cadence"] }); }
  }

  return (
    <div className="space-y-5">
      {/* Status + toggle */}
      <Card className="p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="font-heading text-base font-bold">Resgate de Falta (Layla)</div>
            <div className="mt-1 max-w-xl text-sm text-muted-foreground">
              Envia automaticamente uma sequência de mensagens pra quem faltou (funil), das 9h às 18h, seg–sáb. Para sozinha se o paciente responde ou reagenda.
            </div>
          </div>
          <label className="flex items-center gap-2">
            <span className="text-sm font-semibold" style={{ color: cad?.active ? "#10b981" : undefined }}>
              {cad?.active ? "Ligada" : "Desligada"}
            </span>
            <Switch checked={!!cad?.active} onCheckedChange={toggle} />
          </label>
        </div>
        <div className="mt-4 flex flex-wrap gap-3">
          <Stat label="Na cadência" value={byStatus.active ?? 0} color="#3b82f6" />
          <Stat label="Responderam" value={byStatus.responded ?? 0} color="#10b981" />
          <Stat label="Reagendaram" value={byStatus.rescheduled ?? 0} color="#10b981" />
          <Stat label="Concluídas" value={byStatus.completed ?? 0} />
        </div>
      </Card>

      {/* Faltantes do funil */}
      <div>
        <div className="mb-2 font-heading text-[15px] font-bold">
          Faltantes do funil (Layla) — para resgatar <span className="font-normal text-sm text-muted-foreground">({(noShows ?? []).length} pacientes)</span>
        </div>
        <div className="overflow-x-auto rounded-xl border border-border bg-card">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-muted-foreground">
                <th className="px-4 py-3 font-semibold">Paciente</th>
                <th className="px-4 py-3 font-semibold">Faltou em</th>
                <th className="px-4 py-3 font-semibold">Procedimento</th>
                <th className="px-4 py-3 font-semibold">Situação</th>
                <th className="px-4 py-3 font-semibold text-right">Ação</th>
              </tr>
            </thead>
            <tbody>
              {(noShows ?? []).length === 0 && <tr><td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">Nenhum faltante do funil 🎉</td></tr>}
              {(noShows ?? []).map((r, i) => {
                const k = String(r.phone ?? "").replace(/\D/g, "").slice(-8);
                const st = enrByPhone.get(k);
                const sit = st ? SIT[st] : { txt: "Não contatado", color: "#94a3b8" };
                return (
                  <tr key={i} className="border-b border-white/[.04] last:border-0 hover:bg-white/[.02]">
                    <td className="px-4 py-3 font-medium">{r.patient_name}</td>
                    <td className="px-4 py-3 text-muted-foreground">{formatDateBR(r.appt_date)}</td>
                    <td className="px-4 py-3 text-muted-foreground">{r.category || "—"}</td>
                    <td className="px-4 py-3"><span style={{ color: sit.color }} className="font-semibold">{sit.txt}</span></td>
                    <td className="px-4 py-3 text-right">
                      <Button size="sm" onClick={() => atenderByPhone(r.phone)}><MessageSquare className="h-3.5 w-3.5" /> Atender</Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Mensagens */}
      <div>
        <div className="mb-2 font-heading text-[15px] font-bold">Mensagens dos 4 toques</div>
        <div className="space-y-3">
          {steps.map((s, i) => (
            <Card key={s.step} className="gap-2 p-4">
              <div className="text-xs text-muted-foreground">{rotulo[i] ?? `Toque ${s.step}`}</div>
              <Textarea
                value={editMsgs[i] ?? ""}
                onChange={(e) => { const next = [...editMsgs]; next[i] = e.target.value; setMsgs(next); }}
                rows={3}
              />
            </Card>
          ))}
        </div>
        <div className="mt-3 flex justify-end">
          <Button onClick={saveMsgs} disabled={!msgs}>Salvar mensagens</Button>
        </div>
      </div>

      {/* Inscritos */}
      <div>
        <div className="mb-2 font-heading text-[15px] font-bold">Pacientes na cadência</div>
        <div className="overflow-x-auto rounded-xl border border-border bg-card">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-muted-foreground">
                <th className="px-4 py-3 font-semibold">Paciente</th>
                <th className="px-4 py-3 font-semibold">Toque</th>
                <th className="px-4 py-3 font-semibold">Próximo envio</th>
                <th className="px-4 py-3 font-semibold">Situação</th>
              </tr>
            </thead>
            <tbody>
              {enr.length === 0 && <tr><td colSpan={4} className="px-4 py-6 text-center text-muted-foreground">Ninguém na cadência ainda. Quando alguém do funil faltar, entra aqui (com a cadência ligada).</td></tr>}
              {enr.map((e) => {
                const sit = SIT[e.status] ?? { txt: e.status, color: "#94a3b8" };
                return (
                  <tr key={e.id} className="border-b border-white/[.04] last:border-0">
                    <td className="px-4 py-3 font-medium">{e.patient_name || formatPhoneDisplay(e.phone)}</td>
                    <td className="px-4 py-3 text-muted-foreground">{e.current_step}/4</td>
                    <td className="px-4 py-3 text-muted-foreground">{e.status === "active" && e.next_send_at ? new Date(e.next_send_at).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—"}</td>
                    <td className="px-4 py-3"><span style={{ color: sit.color }} className="font-semibold">{sit.txt}</span></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
