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
      <div className="flex items-center gap-3">
        <Button variant="outline" size="icon" onClick={() => move(-1)}><ChevronLeft className="h-4 w-4" /></Button>
        <div className="font-heading text-lg font-bold">{MES_FULL[ref.m - 1]} / {ref.y}</div>
        <Button variant="outline" size="icon" onClick={() => move(1)}><ChevronRight className="h-4 w-4" /></Button>
        <div className="flex-1" />
        <span className="text-sm text-muted-foreground">{appts.length} consultas</span>
        <NewAppointmentDialog orgId={org.id} onCreated={() => qc.invalidateQueries({ queryKey: ["agenda"] })} />
      </div>

      {isLoading ? (
        <div className="py-10 text-center text-muted-foreground">Carregando agenda do Clinicorp...</div>
      ) : byDate.length === 0 ? (
        <div className="py-10 text-center text-muted-foreground">Nenhuma consulta nesse mês.</div>
      ) : (
        <div className="space-y-5">
          {byDate.map(([date, list]) => (
            <div key={date}>
              <div className="mb-2 text-sm font-semibold text-muted-foreground">
                {date.split("-").reverse().join("/")}
              </div>
              <div className="space-y-2">
                {list.sort((a, b) => a.from.localeCompare(b.from)).map((a) => {
                  const st = ST[a.status] ?? ST.agendado;
                  return (
                    <Card key={a.clinicorp_id} className="flex flex-row items-center gap-4 p-3.5">
                      <div className="w-14 shrink-0 text-center">
                        <div className="font-heading text-sm font-bold">{a.from}</div>
                      </div>
                      <div className="h-8 w-1 rounded-full" style={{ background: a.color || "#6366f1" }} />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium">{a.patient}</div>
                        <div className="truncate text-xs text-muted-foreground">
                          {a.category || "—"} · {formatPhoneDisplay(a.phone)}
                        </div>
                      </div>
                      <span className="shrink-0 text-xs font-semibold" style={{ color: st.color }}>{st.txt}</span>
                      <div className="flex shrink-0 gap-1">
                        <Button variant="ghost" size="icon" title="Compareceu" onClick={() => mark(a, "compareceu")}>
                          <Check className="h-4 w-4 text-emerald-400" />
                        </Button>
                        <Button variant="ghost" size="icon" title="Faltou" onClick={() => mark(a, "faltou")}>
                          <X className="h-4 w-4 text-red-400" />
                        </Button>
                        <Button variant="ghost" size="icon" title="Cancelar consulta" onClick={() => cancelAppt(a)}>
                          <Trash2 className="h-4 w-4 text-muted-foreground" />
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
