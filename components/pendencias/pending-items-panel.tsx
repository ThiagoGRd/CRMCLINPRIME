"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useOrg } from "@/components/org-context";
import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/client";
import { buildPendingCreate, buildPendingUpdate, buildPendingResolution, pendingListScope, type PendingItem, type PendingDraft, type PendingFilter } from "@/lib/pending-items";

type Member = { user_id: string; display_name: string | null };
type Conversation = { id: string; patient_id: string; channel_id: string };
type Patient = { id: string; name: string };
type Channel = { id: string; display_name: string | null; instance_name: string | null };
const field = "min-w-0 w-full rounded-md border border-border bg-background p-2 text-sm";
const emptyDraft: PendingDraft = { title: "", description: "", assigned_to: "", due_at: "", status: "open" };
const statusLabels = { open: "Aberta", in_progress: "Em andamento", resolved: "Resolvida" };

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : typeof error === "object" && error && "message" in error ? String(error.message) : "Não foi possível concluir a operação.";
}
function localDate(value: string) {
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

export function PendingItemsPanel({ patientId, conversationId }: { patientId: string; conversationId: string }) {
  const org = useOrg();
  return <PendingItemsWorkspace key={`${org.id}:${patientId}:${conversationId}`} patientId={patientId} conversationId={conversationId} />;
}

export function PendingItemsWorkspace({ patientId, conversationId }: { patientId?: string; conversationId?: string }) {
  const org = useOrg();
  const supabase = useMemo(() => createClient(), []);
  const qc = useQueryClient();
  const [filter, setFilter] = useState<PendingFilter>("active");
  const [page, setPage] = useState(0);
  const [showCreate, setShowCreate] = useState(false);
  const [selectedConversation, setSelectedConversation] = useState("");
  const [draft, setDraft] = useState<PendingDraft>(emptyDraft);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scope = pendingListScope(org.id, patientId ?? null, conversationId ?? null, filter, page);
  const list = useQuery({
    queryKey: scope.queryKey,
    queryFn: async ({ signal }) => {
      let query = supabase.from("crm_pending_items").select("*", { count: "exact" }).eq("org_id", scope.orgId).in("status", scope.statuses);
      if (scope.patientId) query = query.eq("patient_id", scope.patientId);
      if (scope.conversationId) query = query.eq("conversation_id", scope.conversationId);
      const { data, count, error } = await query.order("due_at").order("id").range(scope.from, scope.to).abortSignal(signal);
      if (error) throw error;
      return { items: (data ?? []) as PendingItem[], count: count ?? 0 };
    },
  });
  const options = useQuery({
    queryKey: ["pending-options", org.id, patientId ?? null, conversationId ?? null],
    queryFn: async ({ signal }) => {
      // Paginate reference data rather than silently dropping records at PostgREST's row limit.
      async function readAll<T>(table: string, columns: string, orderColumn = "id", onlyId?: string) {
        const rows: T[] = [];
        for (let offset = 0; ; offset += 500) {
          let query = supabase.from(table).select(columns).eq("org_id", org.id);
          if (onlyId) query = query.eq("id", onlyId);
          const { data, error } = await query.order(orderColumn).range(offset, offset + 499).abortSignal(signal);
          if (error) throw error;
          rows.push(...((data ?? []) as unknown as T[]));
          if (!data || data.length < 500) return rows;
        }
      }
      const [members, conversations, patients, channels] = await Promise.all([
        readAll<Member>("org_members", "user_id,display_name", "user_id"),
        readAll<Conversation>("crm_conversations", "id,patient_id,channel_id", "id", conversationId),
        readAll<Patient>("crm_patients", "id,name", "id", patientId),
        readAll<Channel>("channels", "id,display_name,instance_name"),
      ]);
      return { members, conversations, patients, channels };
    },
  });
  const members = options.data?.members ?? [];
  const refresh = () => qc.invalidateQueries({ queryKey: ["pending-items", org.id] });
  const patientName = (id: string) => options.data?.patients.find(p => p.id === id)?.name ?? id;
  const conversationName = (conversation: Conversation) => {
    const channel = options.data?.channels.find(c => c.id === conversation.channel_id);
    return `${patientName(conversation.patient_id)} · ${channel?.display_name || channel?.instance_name || conversation.channel_id}`;
  };
  async function create() {
    setBusy(true); setError(null);
    try {
      const conversation = options.data?.conversations.find(c => c.id === (conversationId ?? selectedConversation));
      if (!conversation || (patientId && conversation.patient_id !== patientId)) throw new Error("Selecione uma conversa válida para este paciente.");
      const payload = buildPendingCreate(org.id, conversation.patient_id, conversation.id, draft, members.map(m => m.user_id));
      const { error } = await supabase.from("crm_pending_items").insert(payload).select("id").single();
      if (error) throw error;
      setDraft(emptyDraft); setShowCreate(false); setSelectedConversation("");
      await refresh();
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  }

  return <section className="min-w-0 space-y-3" aria-label="Pendências manuais">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 className="font-semibold">Pendências</h2>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" disabled={list.isFetching || options.isFetching} onClick={() => { void list.refetch(); void options.refetch(); }}>Atualizar</Button>
        <Button onClick={() => setShowCreate(!showCreate)} disabled={busy}>{showCreate ? "Cancelar" : "Nova pendência"}</Button>
      </div>
    </div>
    <p className="text-xs text-muted-foreground">Mensagens não encerram pendências. A resolução é manual e exige evidência. Datas e horários no fuso deste dispositivo.</p>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {options.error && <p role="alert" className="text-sm text-destructive">Erro ao carregar responsáveis e conversas: {errorMessage(options.error)}</p>}
    {showCreate && <form className="space-y-3 rounded-lg border p-3" onSubmit={event => { event.preventDefault(); void create(); }}>
      {!conversationId && <label className="block text-sm">Paciente e conversa<select required className={field} value={selectedConversation} onChange={e => setSelectedConversation(e.target.value)}><option value="">Selecione a conversa</option>{options.data?.conversations.map(c => <option key={c.id} value={c.id}>{conversationName(c)}</option>)}</select></label>}
      <label className="block text-sm">Título<input required maxLength={200} className={field} value={draft.title} onChange={e => setDraft({...draft, title:e.target.value})} /></label>
      <label className="block text-sm">Descrição<textarea className={field} value={draft.description} onChange={e => setDraft({...draft, description:e.target.value})} /></label>
      <AssignmentFields draft={draft} setDraft={setDraft} members={members} />
      {options.isPending && <p className="text-sm">Carregando responsáveis e conversas…</p>}
      {!options.isPending && !options.error && members.length === 0 && <p role="alert" className="text-sm">Cadastre um membro na organização antes de criar uma pendência.</p>}
      <Button type="submit" disabled={busy || !options.isSuccess || members.length === 0}>{busy ? "Salvando…" : "Criar pendência"}</Button>
    </form>}
    <label className="block text-sm">Mostrar<select className={field} value={filter} onChange={e => { setFilter(e.target.value as PendingFilter); setPage(0); }}><option value="active">Abertas e em andamento</option><option value="resolved">Resolvidas</option></select></label>
    {list.isPending && <p className="text-sm">Carregando pendências…</p>}
    {list.error && <p role="alert" className="text-sm text-destructive">Erro ao carregar pendências: {errorMessage(list.error)}</p>}
    {!list.isPending && !list.error && list.data?.items.length === 0 && <p className="text-sm text-muted-foreground">Nenhuma pendência nesta página.</p>}
    {list.data?.items.map(item => <PendingItemCard key={`${item.id}:${item.updated_at}`} item={item} members={members} canEdit={options.isSuccess} patientName={conversationId ? undefined : patientName(item.patient_id)} refresh={refresh} />)}
    <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
      <Button variant="outline" disabled={page === 0 || list.isFetching} onClick={() => setPage(page - 1)}>Anterior</Button>
      <span>Página {page + 1} · {list.data?.count ?? 0} pendências</span>
      <Button variant="outline" disabled={list.isFetching || (page + 1) * 50 >= (list.data?.count ?? 0)} onClick={() => setPage(page + 1)}>Próxima</Button>
    </div>
  </section>;
}

function AssignmentFields({ draft, setDraft, members }: { draft: PendingDraft; setDraft: (draft: PendingDraft) => void; members: Member[] }) {
  return <div className="grid min-w-0 gap-2">
    <label className="text-sm">Responsável<select required className={field} value={draft.assigned_to} onChange={e => setDraft({...draft, assigned_to:e.target.value})}><option value="">Selecione</option>{members.map(m => <option key={m.user_id} value={m.user_id}>{m.display_name || m.user_id}</option>)}</select></label>
    <label className="text-sm">Prazo<input required type="datetime-local" className={field} value={draft.due_at} onChange={e => setDraft({...draft, due_at:e.target.value})} /></label>
    <label className="text-sm">Status<select className={field} value={draft.status} onChange={e => setDraft({...draft, status:e.target.value})}><option value="open">Aberta</option><option value="in_progress">Em andamento</option></select></label>
  </div>;
}

function PendingItemCard({ item, members, canEdit, patientName, refresh }: { item: PendingItem; members: Member[]; canEdit: boolean; patientName?: string; refresh: () => Promise<unknown> }) {
  const supabase = useMemo(() => createClient(), []);
  const [editing, setEditing] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [draft, setDraft] = useState<PendingDraft>({ title:item.title, description:item.description ?? "", assigned_to:item.assigned_to, due_at:localDate(item.due_at), status:item.status });
  const [evidence, setEvidence] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save(resolve: boolean) {
    setBusy(true); setError(null);
    try {
      if (resolve) {
        const { error } = await supabase.rpc("resolve_pending_item", buildPendingResolution(item.id, evidence));
        if (error) throw error;
      } else {
        const payload = buildPendingUpdate(draft, members.map(m => m.user_id));
        const { error } = await supabase.from("crm_pending_items").update(payload).eq("id", item.id).eq("org_id", item.org_id).eq("patient_id", item.patient_id).eq("conversation_id", item.conversation_id).eq("updated_at", item.updated_at).in("status", ["open", "in_progress"]).select("id").single();
        if (error) throw new Error(`Não foi possível salvar. A pendência pode ter sido alterada por outra pessoa; atualize e tente novamente. ${error.message}`);
      }
      setEditing(false); setResolving(false); setEvidence(""); await refresh();
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  }
  return <article className="min-w-0 space-y-2 break-words rounded-lg border bg-card p-3">
    <div className="flex items-start justify-between gap-2"><h3 className="min-w-0 font-medium">{item.title}</h3><span className="text-xs">{statusLabels[item.status]}</span></div>
    {patientName && <p className="text-xs">{patientName} · <Link className="underline" href={`/inbox?c=${encodeURIComponent(item.conversation_id)}`}>Abrir conversa</Link></p>}
    {item.description && <p className="whitespace-pre-wrap text-sm">{item.description}</p>}
    <p className="text-xs text-muted-foreground">Responsável: {members.find(m => m.user_id === item.assigned_to)?.display_name || item.assigned_to}<br />Prazo: {new Date(item.due_at).toLocaleString("pt-BR")}</p>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {item.status === "resolved" ? <div className="text-sm"><p className="whitespace-pre-wrap">Evidência: {item.resolution_evidence}</p><p className="text-xs text-muted-foreground">Resolvida por {members.find(m => m.user_id === item.resolved_by)?.display_name || item.resolved_by} em {item.resolved_at ? new Date(item.resolved_at).toLocaleString("pt-BR") : "—"}</p></div> : <>
      <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={busy || !canEdit} onClick={() => { setEditing(!editing); setResolving(false); }}>Editar pendência</Button><Button variant="outline" disabled={busy} onClick={() => { setResolving(!resolving); setEditing(false); }}>Resolver manualmente</Button></div>
      {editing && <form className="space-y-2" onSubmit={e => { e.preventDefault(); void save(false); }}><AssignmentFields draft={draft} setDraft={setDraft} members={members} /><Button type="submit" disabled={busy || !canEdit}>{busy ? "Salvando…" : "Salvar alterações"}</Button></form>}
      {resolving && <form className="space-y-2" onSubmit={e => { e.preventDefault(); void save(true); }}><label className="block text-sm">Evidência da resolução<textarea required className={field} placeholder="O que foi feito e como a conclusão foi confirmada?" value={evidence} onChange={e => setEvidence(e.target.value)} /></label><Button type="submit" disabled={busy || !evidence.trim()}>{busy ? "Resolvendo…" : "Confirmar resolução"}</Button></form>}
    </>}
  </article>;
}
