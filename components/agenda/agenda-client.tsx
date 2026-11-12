"use client";

import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { useOrg } from "@/components/org-context";
import { formatPhoneDisplay, MES_FULL } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { ChevronLeft, ChevronRight, Check, X, Trash2, Plus } from "lucide-react";
import { toast } from "sonner";

type Appt = {
  clinicorp_id: string; date: string; from: string; to: string;
  patient: string; phone: string; category: string; color: string;
  status: string; attendance_id: string | null; confirmed?: boolean;
};

const ST: Record<string, { txt: string; color: string }> = {
  compareceu: { txt: "Compareceu", color: "#10b981" },
  faltou: { txt: "Faltou", color: "#ef4444" },
  agendado: { txt: "Agendado", color: "#9ca3af" },
};

export function AgendaClient() {
  const org = useOrg();
  const qc = useQueryClient();
  const supabase = useMemo(() => createClient(), []);
  const [ref, setRef] = useState(() => { const d = new Date(); return { y: d.getFullYear(), m: d.getMonth() + 1 }; });

  const from = `${ref.y}-${String(ref.m).padStart(2, "0")}-01`;
  const to = `${ref.y}-${String(ref.m).padStart(2, "0")}-${new Date(ref.y, ref.m, 0).getDate()}`;

  const { data, isLoading } = useQuery({
    queryKey: ["agenda", from, to],
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke("clinicorp-agenda", { body: { from, to, org_id: org.id } });
      if (error) throw error;
      return (data?.appointments ?? []) as Appt[];
    },
  });
  const appts = data ?? [];

  const byDate = useMemo(() => {
    const map = new Map<string, Appt[]>();
    for (const a of appts) { if (!map.has(a.date)) map.set(a.date, []); map.get(a.date)!.push(a); }
    return Array.from(map.entries()).sort((x, y) => x[0].localeCompare(y[0]));
  }, [appts]);

  async function mark(a: Appt, status: string) {
    if (!a.attendance_id) return;
    const { error } = await supabase.functions.invoke("clinicorp-agenda", {
      body: { action: "mark", attendance_id: a.attendance_id, status, org_id: org.id },
    });
    if (error) toast.error("Erro ao marcar");
    else { toast.success(ST[status]?.txt ?? "Atualizado"); qc.invalidateQueries({ queryKey: ["agenda"] }); }
  }

  function move(delta: number) {
    setRef((r) => { let m = r.m + delta, y = r.y; if (m < 1) { m = 12; y--; } if (m > 12) { m = 1; y++; } return { y, m }; });
  }

  async function cancelAppt(a: Appt) {
    if (!confirm(`Cancelar a consulta de ${a.patient} (${a.date.split("-").reverse().join("/")} ${a.from}) no Clinicorp?`)) return;
    const { data, error } = await supabase.functions.invoke("clinicorp-agenda", {
      body: { action: "cancel", appointment_id: a.clinicorp_id, org_id: org.id },
    });
    if (error || data?.error) toast.error("Erro ao cancelar", { description: data?.error ?? error?.message });
    else { toast.success("Consulta cancelada no Clinicorp"); qc.invalidateQueries({ queryKey: ["agenda"] }); }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-white/[0.08] bg-card/80 p-3.5">
        <div className="flex items-center gap-2">
          <Button variant="outline" size="icon-sm" onClick={() => move(-1)} title="Mês anterior">
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <div className="min-w-[160px] text-center font-heading text-base font-bold">
            {MES_FULL[ref.m - 1]} / {ref.y}
          </div>
          <Button variant="outline" size="icon-sm" onClick={() => move(1)} title="Próximo mês">
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
        <div className="flex-1" />
        <span className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-xs font-semibold tabular-nums text-muted-foreground">
          {appts.length} consultas no mês
        </span>
        <NewAppointmentDialog orgId={org.id} onCreated={() => qc.invalidateQueries({ queryKey: ["agenda"] })} />
      </div>

      {isLoading ? (
        <div className="py-10 text-center text-muted-foreground">Carregando agenda do Clinicorp...</div>
      ) : byDate.length === 0 ? (
        <div className="py-10 text-center text-muted-foreground">Nenhuma consulta nesse mês.</div>
      ) : (
        <div className="space-y-6">
          {byDate.map(([date, list]) => (
            <div key={date}>
              <div className="mb-2.5 flex items-center gap-2 text-xs font-semibold tracking-wider text-muted-foreground uppercase">
                <span className="h-1.5 w-1.5 rounded-full bg-primary" />
                <span>{date.split("-").reverse().join("/")}</span>
                <span className="rounded bg-white/[0.05] px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground/80">
                  {list.length} {list.length === 1 ? "horário" : "horários"}
                </span>
              </div>
              <div className="space-y-2.5">
                {list.sort((a, b) => a.from.localeCompare(b.from)).map((a) => {
                  const st = ST[a.status] ?? ST.agendado;
                  const isCompareceu = a.status === "compareceu";
                  const isFaltou = a.status === "faltou";
                  return (
                    <Card
                      key={a.clinicorp_id}
                      className="flex flex-wrap items-center gap-4 p-4 transition-all hover:border-white/15 sm:flex-nowrap"
                    >
                      <div className="flex w-16 shrink-0 flex-col items-center justify-center rounded-lg border border-white/[0.07] bg-white/[0.03] py-1.5 text-center">
                        <div className="font-heading text-sm font-bold tabular-nums text-foreground">{a.from}</div>
                        {a.to && <div className="text-[10px] tabular-nums text-muted-foreground">{a.to}</div>}
                      </div>
                      <div className="h-9 w-1 shrink-0 rounded-full" style={{ background: a.color || "#6366f1" }} />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-semibold text-foreground">{a.patient}</div>
                        <div className="mt-0.5 truncate text-xs text-muted-foreground">
                          {a.category || "Consulta"} · {formatPhoneDisplay(a.phone)}
                        </div>
                      </div>
                      <span
                        className="shrink-0 rounded-full border px-2.5 py-0.5 text-xs font-semibold"
                        style={{
                          color: st.color,
                          borderColor: `${st.color}40`,
                          backgroundColor: `${st.color}15`,
                        }}
                      >
                        {st.txt}
                      </span>
                      <div className="flex shrink-0 items-center gap-1.5">
                        <Button
                          variant={isCompareceu ? "success" : "outline"}
                          size="xs"
                          title="Marcar presença"
                          onClick={() => mark(a, "compareceu")}
                        >
                          <Check className="h-3.5 w-3.5 text-emerald-400" />
                          <span className="hidden md:inline">Compareceu</span>
                        </Button>
                        <Button
                          variant={isFaltou ? "destructive" : "outline"}
                          size="xs"
                          title="Marcar falta"
                          onClick={() => mark(a, "faltou")}
                        >
                          <X className="h-3.5 w-3.5 text-red-400" />
                          <span className="hidden md:inline">Faltou</span>
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          title="Cancelar consulta no Clinicorp"
                          className="hover:border-red-500/30 hover:bg-red-500/15 hover:text-red-400"
                          onClick={() => cancelAppt(a)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </Card>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function NewAppointmentDialog({ orgId, onCreated }: { orgId: string; onCreated: () => void }) {
  const supabase = useMemo(() => createClient(), []);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ name: "", phone: "", date: "", time: "", duration: "30" });
  const [times, setTimes] = useState<string[] | null>(null);

  async function loadTimes(date: string) {
    setForm((f) => ({ ...f, date }));
    setTimes(null);
    if (!date) return;
    const { data } = await supabase.functions.invoke("clinicorp-agenda", {
      body: { action: "available_times", date, org_id: orgId },
    });
    setTimes((data?.times ?? []) as string[]);
  }

  async function create() {
    if (!form.name.trim() || !form.date || !form.time) {
      toast.error("Preencha nome, data e horário");
      return;
    }
    setBusy(true);
    const { data, error } = await supabase.functions.invoke("clinicorp-agenda", {
      body: {
        action: "create",
        name: form.name.trim(),
        phone: form.phone,
        date: form.date,
        time: form.time,
        duration: Number(form.duration) || 30,
        org_id: orgId,
      },
    });
    setBusy(false);
    if (error || data?.error) {
      toast.error("Não foi possível agendar", { description: data?.detail ?? data?.error ?? error?.message });
      return;
    }
    toast.success("Consulta criada no Clinicorp 🎉");
    setOpen(false);
    setForm({ name: "", phone: "", date: "", time: "", duration: "30" });
    setTimes(null);
    onCreated();
  }

  return (
    <>
      <Button onClick={() => setOpen(true)}><Plus className="h-4 w-4" /> Agendar consulta</Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="gap-0 p-0">
          <DialogHeader className="border-b border-border px-6 py-4">
            <DialogTitle className="font-heading">Agendar consulta (Clinicorp)</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 px-6 py-5">
            <div className="space-y-1.5">
              <Label>Nome do paciente</Label>
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Ex: Maria Oliveira" />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label>WhatsApp</Label>
                <Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="82999999999" />
              </div>
              <div className="space-y-1.5">
                <Label>Duração (min)</Label>
                <Input type="number" value={form.duration} onChange={(e) => setForm({ ...form, duration: e.target.value })} />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label>Data</Label>
                <Input type="date" value={form.date} onChange={(e) => loadTimes(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label>Horário</Label>
                <Input type="time" value={form.time} onChange={(e) => setForm({ ...form, time: e.target.value })} />
              </div>
            </div>
            {times !== null && (
              <div>
                <div className="mb-1.5 text-xs text-muted-foreground">
                  {times.length > 0 ? "Horários livres no Clinicorp:" : "Clinicorp não retornou horários configurados pra essa data — informe o horário manualmente."}
                </div>
                <div className="flex max-h-24 flex-wrap gap-1.5 overflow-y-auto">
                  {times.map((t) => (
                    <button
                      key={t}
                      onClick={() => setForm((f) => ({ ...f, time: t }))}
                      className={`rounded-md border px-2 py-1 text-xs ${form.time === t ? "border-primary bg-primary/15 text-primary" : "border-border text-muted-foreground hover:border-primary/40"}`}
                    >
                      {t}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
          <DialogFooter className="border-t border-border px-6 py-4">
            <Button variant="outline" onClick={() => setOpen(false)}>Cancelar</Button>
            <Button onClick={create} disabled={busy}>{busy ? "Agendando..." : "Agendar"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
