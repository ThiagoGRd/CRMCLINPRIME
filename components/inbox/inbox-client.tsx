"use client";

import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { useSearchParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { useOrg } from "@/components/org-context";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ClipboardList, MessagesSquare, Search } from "lucide-react";
import { toast } from "sonner";
import { createTask, listOpenTasks } from "@/lib/tasks-data";
import { invalidateTaskCaches } from "@/lib/task-cache";
import { demandDueAt, demandTitle } from "@/lib/tasks";
import { lastByPatient, MESSAGE_COLUMNS, type InboxMessage, type LastMessage } from "@/lib/inbox";
import { PatientPanel } from "@/components/pacientes/patient-panel";
import { NewTaskDialog } from "@/components/fila/new-task-dialog";
import { ReceptionPilotPanel } from "./reception-pilot-panel";
import { InboxMobileNavigation, inboxPaneClass, type InboxPane } from "./inbox-mobile-navigation";
import { ConversationList } from "./conversation-list";
import { MessageThread } from "./message-bubble";
import { ChatHeader } from "./chat-header";
import { ChatComposer } from "./chat-composer";
import { ContactDetails } from "./contact-details";
import { QuickRepliesDialog } from "./quick-replies-dialog";
import { PanelSelector, TeamBoard, buildPanels, channelLabel, countAwaiting } from "./team-board";

type Conversation = {
  id: string;
  name: string;
  phone: string | null;
  tags: string[] | null;
  assigned_to: string | null;
  treatment_interest: string | null;
  source: string | null;
  clinicorp_status: string | null;
  clinicorp_amount: number | null;
  created_at: string | null;
  last_message_at: string | null;
};
type Message = InboxMessage;
type ChannelItem = {
  id: string;
  instance_name: string;
  display_name: string;
  status: string;
  config: { sector_label?: string; display_phone?: string } | null;
};
type Member = { user_id: string; role: string | null; display_name: string | null };
type QuickReply = { id: string; shortcut: string; content: string };

export function InboxClient() {
  const org = useOrg();
  const qc = useQueryClient();
  const searchParams = useSearchParams();
  const [convs, setConvs] = useState<Conversation[]>([]);
  const [patientChannels, setPatientChannels] = useState<Record<string, string[]>>({});
  const [search, setSearch] = useState("");
  const [channelFilter, setChannelFilter] = useState<string>("all");
  const [sendChannelId, setSendChannelId] = useState<string>("");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [creatingDemand, setCreatingDemand] = useState(false);
  const [showPanel, setShowPanel] = useState(false);
  const [panelPatientId, setPanelPatientId] = useState<string | null>(null);
  const [mobilePane, setMobilePane] = useState<InboxPane>("list");
  const [tagInput, setTagInput] = useState("");
  const [qrOpen, setQrOpen] = useState(false);
  const [qrForm, setQrForm] = useState({ shortcut: "", content: "" });
  const [board, setBoard] = useState(false);
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  // null até montar: rótulos de hora dependem do relógio e não podem divergir do HTML do servidor
  const [now, setNow] = useState<Date | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const activeIdRef = useRef<string | null>(null);
  activeIdRef.current = activeId;

  const supabase = useMemo(() => createClient(), []);

  // Canais WhatsApp conectados na VPS
  const { data: channels } = useQuery({
    queryKey: ["channels"],
    queryFn: async () => {
      const { data } = await supabase
        .from("channels")
        .select("id,instance_name,display_name,status,config")
        .order("created_at", { ascending: true });
      return (data ?? []) as ChannelItem[];
    },
  });

  const activeChannels = useMemo(
    () => (channels ?? []).filter((c) => c.status === "connected" || c.instance_name !== "thiago"),
    [channels]
  );

  const channelMap = useMemo(() => {
    const m = new Map<string, ChannelItem>();
    for (const c of channels ?? []) m.set(c.id, c);
    return m;
  }, [channels]);

  // Equipe (atribuição) e respostas rápidas
  const { data: members } = useQuery({
    queryKey: ["org-members"],
    queryFn: async () => {
      const { data } = await supabase.from("org_members").select("user_id,role,display_name").order("created_at");
      return (data ?? []) as Member[];
    },
  });
  const { data: quickReplies } = useQuery({
    queryKey: ["quick-replies"],
    queryFn: async () => {
      const { data } = await supabase.from("quick_replies").select("id,shortcut,content").order("shortcut");
      return (data ?? []) as QuickReply[];
    },
  });
  // Última mensagem de cada conversa (prévia, hora e "aguardando resposta"); o RLS limita à organização.
  const { data: lastRows } = useQuery({
    queryKey: ["inbox-last", org.id],
    queryFn: async () => {
      const { data } = await supabase
        .from("messages")
        .select("patient_id,direction,content,message_type,created_at")
        .order("created_at", { ascending: false })
        .limit(1500);
      return (data ?? []) as LastMessage[];
    },
  });
  const lastBy = useMemo(() => lastByPatient(lastRows ?? []), [lastRows]);
  // mesma chave do resto do app: o cache de tarefas é compartilhado
  const { data: tasks } = useQuery({ queryKey: ["tasks", org.id], queryFn: () => listOpenTasks(supabase, org.id) });

  useEffect(() => {
    const tick = () => setNow(new Date());
    const first = setTimeout(tick, 0);
    const t = setInterval(tick, 60_000);
    return () => { clearTimeout(first); clearInterval(t); };
  }, []);

  const loadConversations = useCallback(async () => {
    const { data } = await supabase
      .from("patients")
      .select("id,name,phone,tags,assigned_to,treatment_interest,source,clinicorp_status,clinicorp_amount,created_at,last_message_at")
      .order("last_message_at", { ascending: false, nullsFirst: false })
      .limit(350);
    const list = (data ?? []) as Conversation[];
    setConvs((prev) => {
      const currentActive = activeIdRef.current ? prev.find((c) => c.id === activeIdRef.current) : null;
      if (currentActive && !list.some((c) => c.id === currentActive.id)) {
        return [currentActive, ...list];
      }
      return list;
    });

    if (list.length > 0) {
      const ids = list.slice(0, 150).map((c) => c.id);
      const { data: msgChs } = await supabase
        .from("messages")
        .select("patient_id,channel_id")
        .in("patient_id", ids)
        .not("channel_id", "is", null)
        .order("created_at", { ascending: false })
        .limit(2000);
      const map: Record<string, string[]> = {};
      for (const row of msgChs ?? []) {
        const pid = row.patient_id as string;
        const cid = row.channel_id as string;
        if (!map[pid]) map[pid] = [];
        if (!map[pid].includes(cid)) map[pid].push(cid);
      }
      setPatientChannels(map);
    }
  }, [supabase]);

  useEffect(() => { loadConversations(); }, [loadConversations]);

  useEffect(() => {
    const p = searchParams.get("p");
    if (p) { setActiveId(p); setMobilePane("chat"); }
  }, [searchParams]);

  // Histórico da conversa ativa
  useEffect(() => {
    if (!activeId) { setMessages([]); return; }
    let cancelled = false;
    (async () => {
      // Garantir que o paciente selecionado via ?p= esteja na lista convs mesmo se for antigo
      const { data: pat } = await supabase
        .from("patients")
        .select("id,name,phone,tags,assigned_to,treatment_interest,source,clinicorp_status,clinicorp_amount,created_at,last_message_at")
        .eq("id", activeId)
        .maybeSingle();
      if (!cancelled && pat) {
        setConvs((prev) => (prev.some((c) => c.id === pat.id) ? prev : [pat as Conversation, ...prev]));
      }

      const { data } = await supabase
        .from("messages")
        .select(MESSAGE_COLUMNS)
        .eq("patient_id", activeId)
        .order("created_at", { ascending: true })
        .limit(1000);
      if (!cancelled) {
        const rows = (data ?? []) as Message[];
        setMessages(rows);
        const lastWithCh = [...rows].reverse().find((m) => m.channel_id);
        if (lastWithCh?.channel_id) {
          setSendChannelId(lastWithCh.channel_id);
        } else if (channelFilter !== "all") {
          setSendChannelId(channelFilter);
        } else if (activeChannels[0]?.id) {
          setSendChannelId(activeChannels[0].id);
        }

        // Se não houver mensagens no banco mas o paciente tiver telefone, busca histórico na VPS automaticamente
        if (rows.length === 0 && pat?.phone) {
          const { data: syncRes } = await supabase.functions.invoke("evolution-proxy", {
            body: { action: "sync_history", payload: { patient_id: activeId, phone: pat.phone, org_id: org.id } },
          });
          if (!cancelled && (syncRes?.synced ?? 0) > 0) {
            const { data: refreshed } = await supabase
              .from("messages")
              .select(MESSAGE_COLUMNS)
              .eq("patient_id", activeId)
              .order("created_at", { ascending: true })
              .limit(1000);
            if (!cancelled && refreshed) setMessages(refreshed as Message[]);
          }
        }
      }
    })();
    return () => { cancelled = true; };
  }, [activeId, supabase, channelFilter, activeChannels, org.id]);

  // Realtime: setAuth ANTES de subscrever (senão falha em silêncio sob RLS)
  useEffect(() => {
    let channel: ReturnType<typeof supabase.channel> | null = null;
    (async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (session) supabase.realtime.setAuth(session.access_token);
      channel = supabase
        .channel("rt-inbox")
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "crm_messages" },
          (payload) => {
            const row = payload.new as Message;
            if (row && row.patient_id === activeIdRef.current) {
              setMessages((prev) => {
                const idx = prev.findIndex((m) => m.id === row.id);
                if (idx >= 0) {
                  const copy = [...prev];
                  copy[idx] = row;
                  return copy;
                }
                return [...prev, row];
              });
            }
            loadConversations();
            void qc.invalidateQueries({ queryKey: ["inbox-last", org.id] });
          }
        )
        .subscribe();
    })();
    return () => { if (channel) supabase.removeChannel(channel); };
  }, [supabase, loadConversations, qc, org.id]);

  async function send() {
    if (!text.trim() || !activeId || sending) return;
    const conv = convs.find((c) => c.id === activeId);
    if (!conv?.phone) { toast.error("Paciente sem telefone"); return; }
    const content = text.trim();
    setSending(true);
    setText("");
    try {
      const { data: sendRes, error: fnErr } = await supabase.functions.invoke("whatsapp-send", {
        body: {
          patient_id: activeId,
          text: content,
          channel_id: sendChannelId || undefined,
        },
      });
      if (fnErr || sendRes?.error) {
        const detail = await (fnErr as { context?: Response } | null)?.context?.json?.().catch(() => null);
        throw new Error(sendRes?.error ?? detail?.error ?? fnErr?.message ?? "falha no envio");
      }

      const inserted = sendRes?.message;
      if (inserted) {
        setMessages((prev) => (prev.some((m) => m.id === inserted.id) ? prev : [...prev, inserted as Message]));
      }
    } catch (e) {
      toast.error("Não foi possível enviar", { description: String((e as Error).message) });
      setText(content);
    } finally {
      setSending(false);
    }
  }

  async function syncPatientHistory() {
    if (!activeId) return;
    const conv = convs.find((c) => c.id === activeId);
    if (!conv?.phone) {
      toast.error("Paciente sem telefone cadastrado");
      return;
    }
    const tId = toast.loading("Sincronizando histórico de mensagens da VPS...");
    try {
      const { data: res, error } = await supabase.functions.invoke("evolution-proxy", {
        body: { action: "sync_history", payload: { patient_id: activeId, phone: conv.phone, org_id: org.id } },
      });
      if (error || res?.error) throw new Error(res?.error ?? error?.message ?? "Erro ao sincronizar");
      const { data: refreshed } = await supabase
        .from("messages")
        .select(MESSAGE_COLUMNS)
        .eq("patient_id", activeId)
        .order("created_at", { ascending: true })
        .limit(1000);
      if (refreshed) setMessages(refreshed as Message[]);
      toast.success(`Histórico sincronizado (${res?.found ?? 0} mensagens encontradas na VPS)`, { id: tId });
    } catch (e) {
      toast.error("Não foi possível puxar o histórico", { id: tId, description: String((e as Error).message) });
    }
  }

  // Vira tarefa "demanda"; sem messageId usa a última mensagem recebida da conversa.
  async function turnIntoDemand(messageId?: string) {
    if (!activeId || creatingDemand) return;
    const patient = convs.find((c) => c.id === activeId);
    const source = messageId
      ? messages.find((m) => m.id === messageId)
      : [...messages].reverse().find((m) => m.direction !== "outbound");
    const front = org.front ?? "recepcao";
    const dueAt = demandDueAt(new Date(), front, org.settings);
    setCreatingDemand(true);
    try {
      await createTask(supabase, {
        orgId: org.id, patientId: activeId, front, kind: "demanda", ownerId: org.userId,
        title: demandTitle(source?.content ?? null, patient?.name ?? ""),
        dueAt, sourceMessageId: messageId,
      });
      invalidateTaskCaches(qc, org.id);
      const hora = dueAt.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "America/Sao_Paulo" });
      toast.success(`Demanda criada. Prazo: ${hora}.`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setCreatingDemand(false);
    }
  }

  // --- Tags / atribuição ---
  async function patchPatient(patch: Record<string, unknown>, okMsg: string) {
    if (!activeId) return;
    const { error } = await supabase.from("patients").update(patch).eq("id", activeId);
    if (error) { toast.error("Erro ao salvar"); return; }
    toast.success(okMsg);
    loadConversations();
  }
  async function addTag() {
    const t = tagInput.trim();
    if (!t || !activeId) return;
    const conv = convs.find((c) => c.id === activeId);
    const tags = Array.from(new Set([...(conv?.tags ?? []), t]));
    setTagInput("");
    setConvs((prev) => prev.map((c) => (c.id === activeId ? { ...c, tags } : c)));
    await patchPatient({ tags }, `Tag "${t}" adicionada`);
  }
  async function removeTag(t: string) {
    const conv = convs.find((c) => c.id === activeId);
    const tags = (conv?.tags ?? []).filter((x) => x !== t);
    setConvs((prev) => prev.map((c) => (c.id === activeId ? { ...c, tags } : c)));
    await patchPatient({ tags }, `Tag "${t}" removida`);
  }
  async function assign(userId: string) {
    const val = userId === "none" ? null : userId;
    setConvs((prev) => prev.map((c) => (c.id === activeId ? { ...c, assigned_to: val } : c)));
    await patchPatient({ assigned_to: val }, val ? "Atendente atribuído" : "Atribuição removida");
  }

  // --- Respostas rápidas ---
  const qrFiltered = useMemo(() => {
    if (!text.startsWith("/")) return [];
    const q = text.slice(1).toLowerCase();
    return (quickReplies ?? []).filter((r) => r.shortcut.toLowerCase().includes(q)).slice(0, 6);
  }, [text, quickReplies]);

  async function saveQuickReply() {
    const s = qrForm.shortcut.trim().replace(/^\//, "");
    const c = qrForm.content.trim();
    if (!s || !c) { toast.error("Preencha atalho e mensagem"); return; }
    const { error } = await supabase.from("quick_replies").insert({ shortcut: s, content: c, org_id: org.id });
    if (error) toast.error("Erro ao salvar resposta rápida");
    else {
      toast.success("Resposta rápida criada");
      setQrForm({ shortcut: "", content: "" });
      qc.invalidateQueries({ queryKey: ["quick-replies"] });
    }
  }
  async function deleteQuickReply(id: string) {
    await supabase.from("quick_replies").delete().eq("id", id);
    qc.invalidateQueries({ queryKey: ["quick-replies"] });
  }

  // Painéis da equipe (um por canal) com a contagem de "aguardando resposta"; a busca só filtra a lista.
  const panels = useMemo(() => buildPanels(activeChannels, convs, patientChannels, lastBy), [activeChannels, convs, patientChannels, lastBy]);
  const allAwaiting = useMemo(() => countAwaiting(convs, lastBy), [convs, lastBy]);
  const filteredConvs = useMemo(() => {
    const base = channelFilter === "all" ? convs : panels.find((p) => p.id === channelFilter)?.convs ?? [];
    const q = search.trim().toLowerCase();
    return q ? base.filter((c) => c.name?.toLowerCase().includes(q) || (c.phone ?? "").includes(search.trim())) : base;
  }, [convs, panels, channelFilter, search]);

  const active = convs.find((c) => c.id === activeId);
  const memberName = (uid: string | null) =>
    (members ?? []).find((m) => m.user_id === uid)?.display_name ?? "Sem atendente";
  const nextTask = useMemo(
    () => (tasks ?? []).filter((t) => t.patientId === activeId)
      .sort((a, b) => new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime())[0] ?? null,
    [tasks, activeId],
  );

  const panelOf = (channelId?: string | null) => {
    if (!channelId) return null;
    const p = panels.find((x) => x.id === channelId);
    if (p) return { label: p.label, color: p.color };
    const ch = channelMap.get(channelId);
    return ch ? { label: channelLabel(ch), color: "#a5b4fc" } : null;
  };
  const openConversation = (id: string) => { setActiveId(id); setMobilePane("chat"); };

  return (
    <div className="flex h-[calc(100dvh-160px)] min-h-0 min-w-0 flex-col gap-3">
      <ReceptionPilotPanel key={org.id} orgId={org.id} />
      <InboxMobileNavigation view={mobilePane} hasPatient={Boolean(active)} onChange={setMobilePane} />
      {activeChannels.length > 0 && (
        <div className={`${mobilePane === "list" ? "block" : "hidden"} min-w-0 lg:block`}>
          <PanelSelector
            panels={panels} allAwaiting={allAwaiting} value={channelFilter} onChange={setChannelFilter}
            board={board} onBoardChange={setBoard}
          />
        </div>
      )}
      {board && (
        <TeamBoard
          panels={panels} lastBy={lastBy} now={now}
          onOpen={(id, panelId) => { setChannelFilter(panelId); setBoard(false); openConversation(id); }}
        />
      )}
      <div className={`relative flex min-h-0 min-w-0 flex-1 gap-3 ${board ? "lg:hidden" : ""}`}>
      {/* Lista de conversas */}
      <div className={`${inboxPaneClass("list", mobilePane)} min-h-0 w-full shrink-0 flex-col overflow-hidden rounded-2xl border border-white/[0.07] bg-card lg:w-[340px]`}>
        <div className="border-b border-white/[0.06] p-2.5">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar conversa..." aria-label="Buscar conversa"
              className="h-9 rounded-full border-transparent bg-[#1f2236] pl-10"
            />
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <ConversationList
            items={filteredConvs} lastBy={lastBy} now={now} activeId={activeId} onSelect={openConversation}
            panelOf={channelFilter === "all" ? (id) => panelOf(patientChannels[id]?.[0]) : undefined}
            empty={search.trim() ? "Nenhuma conversa encontrada." : "Nenhuma conversa neste painel."}
          />
        </div>
      </div>

      {/* Conversa ativa */}
      <div className={`${inboxPaneClass("chat", mobilePane)} min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border border-white/[0.07] bg-card`}>
        {!active ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center" style={{ background: "radial-gradient(60% 50% at 50% 45%, rgba(99,102,241,0.08), transparent 70%)" }}>
            <span className="grid size-16 place-items-center rounded-2xl bg-primary/10 text-primary ring-1 ring-primary/20">
              <MessagesSquare className="size-7" />
            </span>
            <p className="font-heading text-base font-semibold">Conversas da equipe</p>
            <p className="max-w-xs text-sm text-muted-foreground">Escolha uma conversa para ver as mensagens, fotos, áudios e documentos.</p>
          </div>
        ) : (
          <>
            <ChatHeader
              patient={active} nextTask={nextTask} now={now}
              onBack={() => setMobilePane("list")} onOpenPatient={() => setPanelPatientId(active.id)}
              onDefineNext={() => setNewTaskOpen(true)} onSync={syncPatientHistory}
              onToggleDetails={() => { setShowPanel((v) => !v); setMobilePane("details"); }}
            >
              <Button variant="outline" size="sm" onClick={() => turnIntoDemand()} disabled={creatingDemand}>
                <ClipboardList className="h-4 w-4" />
                <span className="hidden lg:inline">Virar demanda</span>
                <span className="sr-only lg:hidden">Virar demanda</span>
              </Button>
            </ChatHeader>
            <MessageThread
              patientId={active.id} messages={messages} now={now} contactName={active.name}
              senderOf={panelOf} onDemand={(id) => turnIntoDemand(id)} demandDisabled={creatingDemand}
            />
            <ChatComposer
              inputRef={inputRef} text={text} setText={setText} onSend={send} sending={sending}
              suggestions={qrFiltered} onOpenQuickReplies={() => setQrOpen(true)}
              channels={activeChannels.map((ch) => ({ id: ch.id, label: channelLabel(ch), color: panelOf(ch.id)?.color ?? "#9ca3af" }))}
              channelId={sendChannelId} onChannel={setSendChannelId}
            />
          </>
        )}
      </div>

      {/* Painel lateral do paciente */}
      {active && (showPanel || mobilePane === "details") && (
        <ContactDetails
          className={inboxPaneClass("details", mobilePane, showPanel)}
          onClose={() => { setShowPanel(false); if (mobilePane === "details") setMobilePane("chat"); }}
          patient={active} members={members ?? []} memberName={memberName}
          tagInput={tagInput} setTagInput={setTagInput} onAddTag={addTag} onRemoveTag={removeTag} onAssign={assign}
        />
      )}
      </div>

      <QuickRepliesDialog
        open={qrOpen} onOpenChange={setQrOpen} replies={quickReplies ?? []}
        form={qrForm} setForm={setQrForm} onSave={saveQuickReply} onDelete={deleteQuickReply}
      />
      <PatientPanel patientId={panelPatientId} onClose={() => setPanelPatientId(null)} />
      <NewTaskDialog
        open={newTaskOpen} patientId={active?.id} patientName={active?.name}
        onClose={() => setNewTaskOpen(false)} onCreated={() => { setNewTaskOpen(false); invalidateTaskCaches(qc, org.id); }}
      />
    </div>
  );
}
