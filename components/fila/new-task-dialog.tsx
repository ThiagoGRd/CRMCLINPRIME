"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { FRONTS, type Front } from "@/lib/tasks";
import { createTask } from "@/lib/tasks-data";
import { useOrg } from "@/components/org-context";
import { localToIso } from "./datetime";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";

type Props = { open: boolean; patientId?: string; patientName?: string; patientFront?: string | null; onClose: () => void; onCreated: () => void };

export function NewTaskDialog({ open, patientId, patientName, patientFront, onClose, onCreated }: Props) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="font-heading">Nova tarefa</DialogTitle>
        </DialogHeader>
        {open && <NewTaskForm patientId={patientId} patientName={patientName} patientFront={patientFront} onClose={onClose} onCreated={onCreated} />}
      </DialogContent>
    </Dialog>
  );
}

function NewTaskForm({ patientId, patientName, patientFront, onClose, onCreated }: Omit<Props, "open">) {
  const org = useOrg();
  const [search, setSearch] = useState("");
  const [picked, setPicked] = useState<{ id: string; name: string } | null>(null);
  const [title, setTitle] = useState("");
  const [front, setFront] = useState<Front>((patientId ? FRONTS.find((f) => f.key === patientFront)?.key : undefined) ?? org.front ?? "recepcao");
  const [due, setDue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const { data: results } = useQuery({
    queryKey: ["patient-search", org.id, search.trim()],
    enabled: !patientId && search.trim().length > 0,
    queryFn: async () => {
      const { data } = await createClient().from("patients").select("id,name")
        .eq("org_id", org.id).ilike("name", `%${search.trim().replace(/[%_,()]/g, " ")}%`).order("name").limit(20);
      return (data ?? []) as { id: string; name: string }[];
    },
  });

  async function submit() {
    const pid = patientId ?? picked?.id;
    const iso = localToIso(due);
    if (!pid) return setError("Escolha o paciente.");
    if (!title.trim()) return setError("Informe o título da tarefa.");
    if (!iso || new Date(iso).getTime() <= Date.now()) return setError("Informe uma data e hora no futuro.");
    setError(null);
    setSaving(true);
    try {
      await createTask(createClient(), {
        orgId: org.id, patientId: pid, front, kind: "proxima_acao", title: title.trim(), ownerId: org.userId, dueAt: new Date(iso),
      });
      onCreated();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div className="grid gap-2">
        <Label>Paciente</Label>
        {patientId ? (
          <p className="text-sm">{patientName ?? "Paciente selecionado"}</p>
        ) : (
          <>
            <Input placeholder="Buscar por nome" value={search} onChange={(e) => setSearch(e.target.value)} />
            {(results ?? []).length > 0 && (
              <Select value={picked?.id ?? ""} onValueChange={(v) => setPicked((results ?? []).find((r) => r.id === v) ?? null)}>
                <SelectTrigger><SelectValue placeholder="Escolha o paciente">{picked?.name}</SelectValue></SelectTrigger>
                <SelectContent>
                  {(results ?? []).map((r) => <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>)}
                </SelectContent>
              </Select>
            )}
          </>
        )}
      </div>
      <div className="grid gap-2">
        <Label htmlFor="new-title">Título</Label>
        <Input id="new-title" value={title} onChange={(e) => setTitle(e.target.value)} />
      </div>
      <div className="grid gap-2">
        <Label>Frente</Label>
        <Select value={front} onValueChange={(v) => v && setFront(v as Front)}>
          <SelectTrigger><SelectValue>{FRONTS.find((f) => f.key === front)?.label}</SelectValue></SelectTrigger>
          <SelectContent>
            {FRONTS.map((f) => <SelectItem key={f.key} value={f.key}>{f.label}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      <div className="grid gap-2">
        <Label htmlFor="new-due">Data e hora</Label>
        <Input id="new-due" type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} />
      </div>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>Cancelar</Button>
        <Button onClick={submit} disabled={saving}>Criar tarefa</Button>
      </DialogFooter>
    </>
  );
}
