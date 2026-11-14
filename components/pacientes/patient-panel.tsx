"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/client";
import { useOrg } from "@/components/org-context";
import { CC_BADGE } from "@/lib/funil";
import { formatCurrency, formatPhoneDisplay, formatDateBR } from "@/lib/format";
import { FRONTS, urgency } from "@/lib/tasks";
import { listPatientTasks } from "@/lib/tasks-data";
import { invalidateTaskCaches } from "@/lib/task-cache";
import { buildTimeline, matchByPhone } from "@/lib/timeline";
import { NewTaskDialog } from "@/components/fila/new-task-dialog";
import { PatientTimeline } from "./patient-timeline";
import { phoneCanon } from "../../supabase/functions/_shared/wa";
import { MessageSquare, Pencil, Plus } from "lucide-react";

const dueFmt = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

type PatientRow = {
  id: string; name: string; phone: string | null; source: string | null; treatment_interest: string | null;
  channel: string | null; notes: string | null; tags: string[] | null; created_at: string | null;
  clinicorp_status: string | null; clinicorp_amount: number | string | null;
  front: string | null; assigned_to: string | null; care_status: string | null;
};

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  if (!value) return null;
  return (
    <div className="flex items-center justify-between gap-4 border-b border-white/5 py-2">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-right text-sm">{value}</span>
    </div>
  );
}

function Failed({ onRetry }: { onRetry: () => void }) {
  return (
    <div role="alert" className="flex items-center gap-3 text-sm">
      <span>Não foi possível carregar.</span>
      <Button variant="outline" size="sm" onClick={onRetry}>Tentar de novo</Button>
    </div>
  );
}

export function PatientPanel({ patientId, onClose }: { patientId: string | null; onClose: () => void }) {
  return (
    <Dialog open={!!patientId} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="top-0 left-0 h-dvh max-w-none translate-x-0 translate-y-0 grid-rows-[auto_1fr_auto] gap-0 overflow-hidden rounded-none p-0 sm:top-0 sm:right-0 sm:left-auto sm:max-w-[480px] sm:rounded-none">
        {patientId && <PanelBody patientId={patientId} onClose={onClose} />}
      </DialogContent>
    </Dialog>
  );
}

function PanelBody({ patientId, onClose }: { patientId: string; onClose: () => void }) {
  const org = useOrg();
  const router = useRouter();
  const qc = useQueryClient();
  const supabase = useMemo(() => createClient(), []);
  const [newTask, setNewTask] = useState(false);

  const patient = useQuery({
    queryKey: ["patient-panel", org.id, patientId],
    queryFn: async () => {
      const { data, error } = await supabase.from("patients")
        .select("id,name,phone,source,treatment_interest,channel,notes,tags,created_at,clinicorp_status,clinicorp_amount,front,assigned_to,care_status")
        .eq("id", patientId).maybeSingle();
      if (error) throw error;
      return data as PatientRow | null;
    },
  });
  const p = patient.data;

  const stage = useQuery({
    queryKey: ["patient-panel-stage", org.id, patientId],
    queryFn: async () => {
      const [deal, stages] = await Promise.all([
        supabase.from("deals").select("stage_id").eq("patient_id", patientId).maybeSingle(),
        supabase.from("pipeline_stages").select("id,name").order("position"),
      ]);
      if (deal.error || stages.error) throw deal.error ?? stages.error;
      const list = (stages.data ?? []) as { id: string; name: string }[];
      return list.find((s) => s.id === deal.data?.stage_id)?.name ?? list[0]?.name ?? null;
    },
  });

  const owner = useQuery({
    queryKey: ["patient-panel-owner", org.id, p?.assigned_to],
    enabled: !!p?.assigned_to,
    queryFn: async () => {
      const { data, error } = await supabase.from("org_members").select("display_name").eq("org_id", org.id).eq("user_id", p!.assigned_to!).maybeSingle();
      if (error) throw error;
      return (data?.display_name as string | null) ?? null;
    },
  });

  const tasks = useQuery({ queryKey: ["patient-tasks", patientId], queryFn: () => listPatientTasks(supabase, patientId) });

  const phone = p?.phone ?? "";
  const history = useQuery({
    queryKey: ["patient-history", org.id, patientId, phone],
    enabled: !!p,
    queryFn: async () => {
      const canon = phoneCanon(phone);
      const last4 = phone.replace(/\D/g, "").slice(-4);
      const [msgs, est, att] = await Promise.all([
        supabase.from("messages").select("created_at,direction,content,message_type").eq("patient_id", patientId).order("created_at", { ascending: false }).limit(200),
        canon ? supabase.from("crm_estimates").select("est_date,status,amount").eq("org_id", org.id).eq("phone_canon", canon) : null,
        canon ? supabase.from("crm_attendances").select("phone,appt_date,from_time,status,category").eq("org_id", org.id).ilike("phone", `%${last4}`) : null,
      ]);
      const err = msgs.error ?? est?.error ?? att?.error;
      if (err) throw err;
      return {
        messages: msgs.data ?? [],
        estimates: est?.data ?? [],
        attendances: matchByPhone((att?.data ?? []) as { phone: string | null; appt_date: string; from_time: string | null; status: string; category: string | null }[], canon, phoneCanon),
      };
    },
  });

  const timeline = useMemo(
    () => (history.data && tasks.data ? buildTimeline({ ...history.data, tasks: tasks.data }) : null),
    [history.data, tasks.data],
  );
  const next = useMemo(
    () => (tasks.data ?? []).filter((t) => t.status === "aberta").sort((a, b) => a.dueAt.localeCompare(b.dueAt))[0] ?? null,
    [tasks.data],
  );

  function created() {
    setNewTask(false);
    invalidateTaskCaches(qc, org.id);
  }

  if (patient.isError || (patient.isSuccess && !p)) {
    return (
      <div className="p-6">
        <DialogTitle className="mb-3">Paciente</DialogTitle>
        <Failed onRetry={() => void patient.refetch()} />
      </div>
    );
  }
  if (!p) {
    return (
      <div className="p-6">
        <DialogTitle className="mb-3">Paciente</DialogTitle>
        <p className="text-sm text-muted-foreground">Carregando...</p>
      </div>
    );
  }

  const cc = p.clinicorp_status ? CC_BADGE[p.clinicorp_status] : null;
  const amount = Number(p.clinicorp_amount) || 0;
  const frontLabel = FRONTS.find((f) => f.key === p.front)?.label;
  const overdue = next ? urgency(next.dueAt, new Date()) === "vencida" : false;

  return (
    <>
      <header className="space-y-2 border-b border-border px-4 py-4 pr-12 sm:px-6">
        <DialogTitle className="font-heading text-lg break-words">{p.name}</DialogTitle>
        <p className="text-xs text-muted-foreground">
          {formatPhoneDisplay(p.phone)} · {frontLabel ?? "Sem frente"} · {p.assigned_to ? (owner.isError ? "Responsável indisponível" : owner.data ?? "...") : "Sem responsável"}
        </p>
        {cc ? (
          <span className="inline-flex rounded-md px-2 py-[3px] text-[11px] font-semibold" style={{ background: cc.bg, color: cc.color }}>
            {cc.label}{amount ? " · " + formatCurrency(amount) : ""}
          </span>
        ) : (
          <span className="block text-xs text-muted-foreground">Sem orçamento no Clinicorp</span>
        )}
        <div className="text-sm">
          {tasks.isError ? <Failed onRetry={() => void tasks.refetch()} />
            : !tasks.data ? <span className="text-muted-foreground">Carregando...</span>
            : next ? (
              <span>
                <span className="text-muted-foreground">Próxima ação: </span>{next.title}
                <span className={overdue ? "font-semibold text-red-400" : "text-muted-foreground"}> · {overdue ? "vencida em " : "até "}{dueFmt.format(new Date(next.dueAt))}</span>
              </span>
            ) : (
              <span className="inline-flex items-center gap-3">
                <span role="alert" className="font-semibold text-red-400">Sem próxima ação</span>
                <Button variant="outline" size="sm" onClick={() => setNewTask(true)}>Definir</Button>
              </span>
            )}
        </div>
      </header>

      <div className="min-h-0 space-y-6 overflow-y-auto px-4 py-4 sm:px-6">
        <section aria-label="Dados do paciente">
          <Row label="Etapa no funil" value={stage.isError ? "Indisponível" : stage.data} />
          <Row label="Interesse / Tratamento" value={p.treatment_interest || p.source} />
          <Row label="Origem" value={p.channel} />
          <Row label="Etiquetas" value={p.tags?.join(", ")} />
          <Row label="Entrou em" value={formatDateBR(p.created_at)} />
          {p.notes && (
            <div className="mt-3">
              <div className="mb-1.5 text-sm text-muted-foreground">Anotações</div>
              <div className="rounded-lg bg-bg-tertiary p-3 text-sm leading-relaxed">{p.notes}</div>
            </div>
          )}
        </section>
        <section aria-label="Linha do tempo">
          <h2 className="mb-3 text-sm font-semibold">Linha do tempo</h2>
          {history.isError || tasks.isError ? (
            <Failed onRetry={() => { void history.refetch(); void tasks.refetch(); }} />
          ) : timeline ? <PatientTimeline items={timeline} /> : <p className="text-sm text-muted-foreground">Carregando...</p>}
        </section>
      </div>

      <footer className="flex flex-col-reverse gap-2 border-t border-border bg-muted/50 p-4 sm:flex-row sm:justify-end sm:px-6">
        <Button variant="outline" onClick={() => { onClose(); router.push(`/pacientes?editar=${p.id}`); }}>
          <Pencil className="h-4 w-4" /> Editar cadastro
        </Button>
        <Button variant="outline" onClick={() => setNewTask(true)}>
          <Plus className="h-4 w-4" /> Nova tarefa
        </Button>
        <Button variant="success" onClick={() => { onClose(); router.push(`/inbox?p=${p.id}`); }}>
          <MessageSquare className="h-4 w-4" /> Abrir conversa
        </Button>
      </footer>
      <NewTaskDialog open={newTask} patientId={p.id} patientName={p.name} patientFront={p.front} onClose={() => setNewTask(false)} onCreated={created} />
    </>
  );
}
