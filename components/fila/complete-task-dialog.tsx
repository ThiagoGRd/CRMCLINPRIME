"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { validateCompletion, type Task } from "@/lib/tasks";
import { completeTask } from "@/lib/tasks-data";
import { localToIso } from "./datetime";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { toast } from "sonner";

type Props = { task: Task | null; onClose: () => void; onDone: () => void };

export function CompleteTaskDialog({ task, onClose, onDone }: Props) {
  return (
    <Dialog open={!!task} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="font-heading">Concluir tarefa</DialogTitle>
        </DialogHeader>
        {/* key remonta o formulário a cada tarefa, zerando o estado */}
        {task && <CompleteForm key={task.id} task={task} onClose={onClose} onDone={onDone} />}
      </DialogContent>
    </Dialog>
  );
}

function CompleteForm({ task, onClose, onDone }: { task: Task; onClose: () => void; onDone: () => void }) {
  const [outcome, setOutcome] = useState("");
  const [mode, setMode] = useState<"proxima" | "encerrar">("proxima");
  const [nextTitle, setNextTitle] = useState("");
  const [nextDue, setNextDue] = useState("");
  const [closeReason, setCloseReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit() {
    const proxima = mode === "proxima";
    const iso = proxima ? localToIso(nextDue) : null;
    if (proxima && !iso) return setError("Informe a data e hora da próxima ação.");
    const input = proxima
      ? { nextTitle, nextDue: iso ?? "", closeReason: "" }
      : { nextTitle: "", nextDue: "", closeReason };
    const msg = validateCompletion(input, new Date());
    if (msg) return setError(msg);
    setError(null);
    setSaving(true);
    try {
      await completeTask(createClient(), {
        taskId: task.id, outcome, ...input, nextFront: null, // passagem entre frentes fica para uma fase seguinte
      });
      onDone();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <p className="text-sm text-muted-foreground">{task.patientName}: {task.title}</p>
      <div className="grid gap-2">
        <Label htmlFor="outcome">Resultado</Label>
        <Textarea id="outcome" value={outcome} onChange={(e) => setOutcome(e.target.value)} placeholder="O que aconteceu?" />
      </div>
      <Tabs value={mode} onValueChange={(v) => { setMode(v as typeof mode); setError(null); }}>
        <TabsList>
          <TabsTrigger value="proxima">Próxima ação</TabsTrigger>
          <TabsTrigger value="encerrar">Encerrar paciente</TabsTrigger>
        </TabsList>
        <TabsContent value="proxima" className="grid gap-3 pt-2">
          <div className="grid gap-2">
            <Label htmlFor="next-title">Título</Label>
            <Input id="next-title" value={nextTitle} onChange={(e) => setNextTitle(e.target.value)} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="next-due">Data e hora</Label>
            <Input id="next-due" type="datetime-local" value={nextDue} onChange={(e) => setNextDue(e.target.value)} />
          </div>
        </TabsContent>
        <TabsContent value="encerrar" className="grid gap-2 pt-2">
          <Label htmlFor="close-reason">Motivo</Label>
          <Input id="close-reason" value={closeReason} onChange={(e) => setCloseReason(e.target.value)} />
        </TabsContent>
      </Tabs>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>Cancelar</Button>
        <Button onClick={submit} disabled={saving}>Concluir</Button>
      </DialogFooter>
    </>
  );
}
