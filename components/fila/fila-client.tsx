"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { useOrg } from "@/components/org-context";
import { FRONTS, type Task } from "@/lib/tasks";
import { listForgotten, listOpenTasks, snoozeTask } from "@/lib/tasks-data";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Plus } from "lucide-react";
import { toast } from "sonner";
import { FilaList, splitQueue, type ForgottenPatient } from "./fila-list";
import { CompleteTaskDialog } from "./complete-task-dialog";
import { NewTaskDialog } from "./new-task-dialog";
import { localToIso } from "./datetime";

const ALL = "todas";

function SnoozeDialog({ task, onClose, onDone }: { task: Task | null; onClose: () => void; onDone: () => void }) {
  const org = useOrg();
  const [due, setDue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit() {
    const iso = localToIso(due);
    if (!task || !iso || new Date(iso).getTime() <= Date.now()) return setError("Informe uma data e hora no futuro.");
    setError(null);
    setSaving(true);
    try {
      const supabase = createClient();
      // Task não carrega o contador; lê o valor atual da view para somar 1.
      const { data } = await supabase.from("tasks").select("snooze_count").eq("id", task.id).maybeSingle();
      await snoozeTask(supabase, { taskId: task.id, orgId: org.id, dueAt: new Date(iso), snoozeCount: Number(data?.snooze_count ?? 0) });
      setDue("");
      onDone();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={!!task} onOpenChange={(o) => { if (!o) { setDue(""); setError(null); onClose(); } }}>
      <DialogContent>
        <DialogHeader><DialogTitle className="font-heading">Adiar tarefa</DialogTitle></DialogHeader>
        <p className="text-sm text-muted-foreground">{task?.patientName}: {task?.title}</p>
        <div className="grid gap-2">
          <Label htmlFor="snooze-due">Novo prazo</Label>
          <Input id="snooze-due" type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} />
        </div>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button onClick={submit} disabled={saving}>Adiar</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function FilaClient() {
  const org = useOrg();
  const router = useRouter();
  const qc = useQueryClient();
  const supabase = useMemo(() => createClient(), []);
  const [tab, setTab] = useState<string>(org.front ?? ALL);
  const [onlyMine, setOnlyMine] = useState(false);
  const [now, setNow] = useState(() => new Date());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [completing, setCompleting] = useState<Task | null>(null);
  const [snoozing, setSnoozing] = useState<Task | null>(null);
  const [newFor, setNewFor] = useState<{ id?: string; name?: string } | null>(null);

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(t);
  }, []);

  const { data: tasks } = useQuery({ queryKey: ["tasks", org.id], queryFn: () => listOpenTasks(supabase, org.id) });
  const { data: forgotten } = useQuery({ queryKey: ["forgotten", org.id], queryFn: () => listForgotten(supabase, org.id) });
  const { data: memberIds } = useQuery({
    queryKey: ["org-member-ids", org.id],
    queryFn: async () => {
      const { data } = await supabase.from("org_members").select("user_id").eq("org_id", org.id);
      return (data ?? []).map((m) => m.user_id as string);
    },
  });

  const refresh = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ["tasks", org.id] });
    void qc.invalidateQueries({ queryKey: ["forgotten", org.id] });
  }, [qc, org.id]);

  // Realtime: setAuth ANTES de subscrever (senão falha em silêncio sob RLS)
  useEffect(() => {
    let channel: ReturnType<typeof supabase.channel> | null = null;
    (async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (session) supabase.realtime.setAuth(session.access_token);
      channel = supabase
        .channel("rt-tasks")
        .on("postgres_changes", { event: "*", schema: "public", table: "crm_tasks" }, refresh)
        .subscribe();
    })();
    return () => { if (channel) supabase.removeChannel(channel); };
  }, [supabase, refresh]);

  const me = useMemo(() => ({ userId: org.userId, isManager: org.isManager }), [org.userId, org.isManager]);
  const shown = useMemo(
    () => (tasks ?? []).filter((t) => (tab === ALL || t.front === tab) && (!onlyMine || t.ownerId === org.userId)),
    [tasks, tab, onlyMine, org.userId],
  );
  const shownForgotten = useMemo<ForgottenPatient[]>(
    () => (forgotten ?? []).filter((f) => tab === ALL || f.front === tab),
    [forgotten, tab],
  );
  const members = useMemo(() => memberIds ?? [], [memberIds]);
  const order = useMemo(() => {
    const { owned, unowned } = splitQueue({ tasks: shown, now, me, memberIds: members });
    return [...owned, ...unowned];
  }, [shown, now, me, members]);
  const selected = order.find((t) => t.id === selectedId) ?? order[0] ?? null;

  const open = useCallback((t: Task) => router.push(`/inbox?p=${t.patientId}`), [router]);
  const dialogOpen = !!completing || !!snoozing || !!newFor;

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey || dialogOpen) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
      const i = selected ? order.indexOf(selected) : -1;
      if (e.key === "j") setSelectedId(order[Math.min(i + 1, order.length - 1)]?.id ?? null);
      else if (e.key === "k") setSelectedId(order[Math.max(i - 1, 0)]?.id ?? null);
      else if (selected && e.key === "f") setCompleting(selected);
      else if (selected && e.key === "a") setSnoozing(selected);
      else if (selected && e.key === "Enter" && !el?.closest("button, a")) open(selected);
      else return;
      e.preventDefault();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [order, selected, dialogOpen, open]);

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="font-heading text-xl font-semibold">Minha fila</h1>
        <Button onClick={() => setNewFor({})}><Plus className="h-4 w-4" /> Nova tarefa</Button>
      </div>
      <Link href="/followup" className="block text-xs text-muted-foreground underline-offset-4 hover:underline">
        Orçamentos em aberto e faltas
      </Link>
      <div className="flex flex-wrap items-center gap-3">
        <div className="max-w-full overflow-x-auto">
          <Tabs value={tab} onValueChange={(v) => setTab(String(v))}>
            <TabsList>
              <TabsTrigger value={ALL}>Todas</TabsTrigger>
              {FRONTS.map((f) => <TabsTrigger key={f.key} value={f.key}>{f.label}</TabsTrigger>)}
            </TabsList>
          </Tabs>
        </div>
        {org.isManager && (
          <div className="flex items-center gap-2">
            <Switch id="only-mine" checked={onlyMine} onCheckedChange={setOnlyMine} />
            <Label htmlFor="only-mine">Só as minhas</Label>
          </div>
        )}
      </div>
      <FilaList
        tasks={shown} now={now} me={me} memberIds={members} forgotten={shownForgotten}
        selectedId={selected?.id ?? null}
        onOpen={open} onDone={setCompleting} onSnooze={setSnoozing}
        onDefineNext={(p) => setNewFor({ id: p.id, name: p.name })}
      />
      <CompleteTaskDialog task={completing} onClose={() => setCompleting(null)} onDone={() => { setCompleting(null); refresh(); }} />
      <SnoozeDialog task={snoozing} onClose={() => setSnoozing(null)} onDone={() => { setSnoozing(null); refresh(); }} />
      <NewTaskDialog
        open={!!newFor} patientId={newFor?.id} patientName={newFor?.name}
        onClose={() => setNewFor(null)} onCreated={() => { setNewFor(null); refresh(); }}
      />
    </div>
  );
}
