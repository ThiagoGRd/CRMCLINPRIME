"use client";

import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { useSearchParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { useOrg } from "@/components/org-context";
import { CC_BADGE } from "@/lib/funil";
import { formatPhoneDisplay, formatCurrency, formatDateBR } from "@/lib/format";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Send, Search, Bot, User, Zap, X, PanelRight, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { ReceptionPilotPanel } from "./reception-pilot-panel";
import { InboxMobileNavigation, inboxPaneClass, type InboxPane } from "./inbox-mobile-navigation";

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
type Message = {
  id: string;
  patient_id: string;
  channel_id?: string | null;
  direction: string;
  content: string;
  created_at: string;
};
type ChannelItem = {
  id: string;
  instance_name: string;
  display_name: string;
  status: string;
  config: { sector_label?: string; display_phone?: string } | null;
};
type Member = { user_id: string; role: string | null; display_name: string | null };
type QuickReply = { id: string; shortcut: string; content: string };

const SHORT_CHANNEL_LABEL: Record<string, string> = {
  recepcao: "Recepção",
  layla: "Layla (CRC)",
  diana: "Diana (Comercial)",
  thiago: "Dr. Thiago",
};

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
  const [aiPaused, setAiPaused] = useState(false);
  const [showPanel, setShowPanel] = useState(true);
  const [mobilePane, setMobilePane] = useState<InboxPane>("list");
  const [tagInput, setTagInput] = useState("");
  const [qrOpen, setQrOpen] = useState(false);
  const [qrForm, setQrForm] = useState({ shortcut: "", content: "" });
  const bottomRef = useRef<HTMLDivElement>(null);
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

  const loadConversations = useCallback(async () => {
    const { data } = await supabase
      .from("patients")
      .select("id,name,phone,tags,assigned_to,treatment_interest,source,clinicorp_status,clinicorp_amount,created_at,last_message_at")
      .order("last_message_at", { ascending: false, nullsFirst: false })
      .limit(120);
    const list = (data ?? []) as Conversation[];
    setConvs(list);

    if (list.length > 0) {
      const ids = list.slice(0, 80).map((c) => c.id);
      const { data: msgChs } = await supabase
        .from("messages")
        .select("patient_id,channel_id")
        .in("patient_id", ids)
        .not("channel_id", "is", null)
        .order("created_at", { ascending: false })
        .limit(500);
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

  // Histórico + status IA da conversa ativa
  useEffect(() => {
    if (!activeId) { setMessages([]); return; }
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from("messages")
        .select("id,patient_id,channel_id,direction,content,created_at")
        .eq("patient_id", activeId)
        .order("created_at", { ascending: true });
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
      }

      const { data: pat } = await supabase.from("patients").select("phone").eq("id", activeId).maybeSingle();
      const phone = String(pat?.phone ?? "").replace(/\D/g, "");
      if (phone) {
        const { data: chat } = await supabase
          .from("chats").select("ai_service").ilike("phone", `${phone}%`).limit(1).maybeSingle();
        if (!cancelled) setAiPaused(String(chat?.ai_service ?? "").startsWith("pause"));
      }
    })();
    return () => { cancelled = true; };
  }, [activeId, supabase, channelFilter, activeChannels]);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);

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
          }
        )
        .subscribe();
    })();
    return () => { if (channel) supabase.removeChannel(channel); };
  }, [supabase, loadConversations]);

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

  async function toggleAi() {
    const conv = convs.find((c) => c.id === activeId);
    const phone = (conv?.phone ?? "").replace(/\D/g, "");
    if (!phone) return;
    const next = aiPaused ? "ativo" : "pause";
    setAiPaused(!aiPaused);
    const { error } = await supabase.from("chats").update({ ai_service: next }).ilike("phone", `${phone}%`);
    if (error) { setAiPaused(aiPaused); toast.error("Erro ao alterar IA"); }
    else toast.success(next === "pause" ? "Você assumiu o atendimento" : "IA reativada");
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

  const filteredConvs = useMemo(() => {
    return convs.filter((c) => {
      if (channelFilter !== "all") {
        const chIds = patientChannels[c.id] ?? [];
        if (!chIds.includes(channelFilter)) return false;
      }
      if (search.trim()) {
        const q = search.toLowerCase();
        return c.name?.toLowerCase().includes(q) || (c.phone ?? "").includes(search);
      }
      return true;
    });
  }, [convs, channelFilter, patientChannels, search]);

  const active = convs.find((c) => c.id === activeId);
  const cc = active?.clinicorp_status ? CC_BADGE[active.clinicorp_status] : null;
  const memberName = (uid: string | null) =>
    (members ?? []).find((m) => m.user_id === uid)?.display_name ?? "Sem atendente";

  const shortChannelName = (channelId?: string | null) => {
    if (!channelId) return null;
    const ch = channelMap.get(channelId);
    if (!ch) return null;
    return SHORT_CHANNEL_LABEL[ch.instance_name] ?? ch.display_name;
  };

  return (
    <div className="flex h-[calc(100dvh-160px)] min-h-0 min-w-0 flex-col gap-2">
      <ReceptionPilotPanel key={org.id} orgId={org.id} />
      <InboxMobileNavigation view={mobilePane} hasPatient={Boolean(active)} onChange={setMobilePane} />
      <div className="flex min-h-0 min-w-0 flex-1 gap-4">
      {/* Lista de conversas */}
      <div className={`${inboxPaneClass("list", mobilePane)} min-h-0 w-full shrink-0 flex-col rounded-xl border border-border bg-card lg:w-80`}>
        <div className="space-y-2 border-b border-border p-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar conversa..." className="pl-9" />
          </div>
          {activeChannels.length > 0 && (
            <div className="flex flex-wrap gap-1">
              <button
                type="button"
                onClick={() => setChannelFilter("all")}
                className={`rounded-md px-2 py-1 text-[11px] font-medium transition-colors ${
                  channelFilter === "all"
                    ? "bg-primary text-primary-foreground"
                    : "bg-bg-tertiary text-muted-foreground hover:text-foreground"
                }`}
              >
                Todos
              </button>
              {activeChannels.map((ch) => (
                <button
                  key={ch.id}
                  type="button"
                  onClick={() => setChannelFilter(ch.id)}
                  className={`flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors ${
                    channelFilter === ch.id
                      ? "bg-primary text-primary-foreground"
                      : "bg-bg-tertiary text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <span
                    className="h-1.5 w-1.5 rounded-full"
                    style={{ background: ch.status === "connected" ? "#10b981" : "#ef4444" }}
                  />
                  {SHORT_CHANNEL_LABEL[ch.instance_name] ?? ch.display_name}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="flex-1 overflow-y-auto">
          {filteredConvs.map((c) => {
            const chIds = patientChannels[c.id] ?? [];
            const primaryCh = chIds[0] ? shortChannelName(chIds[0]) : null;
            return (
              <button
                key={c.id}
                onClick={() => { setActiveId(c.id); setMobilePane("chat"); }}
                className={`flex w-full items-center gap-3 border-b border-white/[.04] px-3 py-3 text-left transition-colors hover:bg-white/[.03] ${
                  activeId === c.id ? "bg-primary/10" : ""
                }`}
              >
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-primary to-emerald-500 text-xs font-bold text-white">
                  {(c.name ?? "?").slice(0, 2).toUpperCase()}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-1">
                    <div className="truncate text-sm font-medium">{c.name}</div>
                    {primaryCh && (
                      <span className="shrink-0 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-400">
                        {primaryCh}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-xs text-muted-foreground">{formatPhoneDisplay(c.phone)}</span>
                    {(c.tags ?? []).slice(0, 1).map((t) => (
                      <span key={t} className="shrink-0 rounded bg-primary/15 px-1 text-[10px] text-primary">{t}</span>
                    ))}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Conversa ativa */}
      <div className={`${inboxPaneClass("chat", mobilePane)} min-h-0 min-w-0 flex-1 flex-col rounded-xl border border-border bg-card`}>
        {!active ? (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
            Selecione uma conversa
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-3.5 sm:px-5">
              <div className="min-w-0">
                <div className="truncate font-heading font-semibold">{active.name}</div>
                <div className="text-xs text-muted-foreground">
                  {formatPhoneDisplay(active.phone)} · {memberName(active.assigned_to)}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {activeChannels.length > 0 && (
                  <Select value={sendChannelId} onValueChange={(v) => setSendChannelId(v ?? "")}>
                    <SelectTrigger className="h-8 w-[165px] text-xs">
                      <SelectValue placeholder="Canal de envio">
                        {shortChannelName(sendChannelId) ?? "Canal de envio"}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {activeChannels.map((ch) => (
                        <SelectItem key={ch.id} value={ch.id}>
                          {SHORT_CHANNEL_LABEL[ch.instance_name] ?? ch.display_name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
                <Button variant={aiPaused ? "default" : "outline"} size="sm" onClick={toggleAi}>
                  {aiPaused ? <User className="h-4 w-4" /> : <Bot className="h-4 w-4" />}
                  {aiPaused ? "Você atendendo" : "IA ativa"}
                </Button>
                <Button variant="ghost" size="icon" title="Painel do paciente" onClick={() => { setShowPanel((v) => !v); setMobilePane("details"); }}>
                  <PanelRight className="h-4 w-4" />
                </Button>
              </div>
            </div>

            <div className="flex-1 space-y-2 overflow-y-auto px-5 py-4">
              {messages.length === 0 && (
                <div className="py-8 text-center text-sm text-muted-foreground">
                  Nenhuma mensagem ainda.
                </div>
              )}
              {messages.map((m) => {
                const out = m.direction === "outbound";
                const chName = shortChannelName(m.channel_id);
                const timeStr = m.created_at
                  ? new Date(m.created_at).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })
                  : "";
                return (
                  <div key={m.id} className={`flex ${out ? "justify-end" : "justify-start"}`}>
                    <div
                      className={`max-w-[70%] whitespace-pre-wrap rounded-2xl px-3.5 py-2 text-sm ${
                        out ? "bg-primary text-primary-foreground" : "bg-bg-tertiary text-foreground"
                      }`}
                    >
                      <div>{m.content}</div>
                      {(chName || timeStr) && (
                        <div className={`mt-1 flex items-center justify-end gap-1.5 text-[10px] ${out ? "text-primary-foreground/75" : "text-muted-foreground"}`}>
                          {chName && <span>{chName}</span>}
                          {timeStr && <span>{timeStr}</span>}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
              <div ref={bottomRef} />
            </div>

            {/* Popup de respostas rápidas ao digitar "/" */}
            {qrFiltered.length > 0 && (
              <div className="mx-3 mb-1 overflow-hidden rounded-lg border border-border bg-popover">
                {qrFiltered.map((r) => (
                  <button
                    key={r.id}
                    className="flex w-full items-start gap-2 border-b border-white/[.04] px-3 py-2 text-left text-sm last:border-0 hover:bg-white/[.04]"
                    onClick={() => { setText(r.content); inputRef.current?.focus(); }}
                  >
                    <Zap className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400" />
                    <span><strong>/{r.shortcut}</strong> — <span className="text-muted-foreground">{r.content.slice(0, 70)}{r.content.length > 70 ? "…" : ""}</span></span>
                  </button>
                ))}
              </div>
            )}

            <div className="flex items-center gap-2 border-t border-border p-3">
              <Button variant="ghost" size="icon" title="Respostas rápidas" onClick={() => setQrOpen(true)}>
                <Zap className="h-4 w-4 text-amber-400" />
              </Button>
              <Input
                ref={inputRef}
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && qrFiltered.length === 0) { e.preventDefault(); send(); } }}
                placeholder="Digite uma mensagem... ( / para respostas rápidas)"
              />
              <Button onClick={send} disabled={sending || !text.trim()} size="icon">
                <Send className="h-4 w-4" />
              </Button>
            </div>
          </>
        )}
      </div>

      {/* Painel lateral do paciente */}
      {active && (showPanel || mobilePane === "details") && (
        <div className={`${inboxPaneClass("details", mobilePane, showPanel)} min-h-0 w-full min-w-0 shrink-0 flex-col gap-5 overflow-y-auto rounded-xl border border-border bg-card p-4 lg:w-72`}>
          <div>
            <div className="font-heading text-sm font-bold">Paciente</div>
            <div className="mt-2.5 space-y-2">
              <Row label="WhatsApp" value={formatPhoneDisplay(active.phone)} />
              <Row label="Interesse" value={active.treatment_interest || active.source || "—"} />
              <Row
                label="Orçamento"
                value={
                  cc ? (
                    <span style={{ color: cc.color }} className="font-semibold">
                      {cc.label.replace(/^[✓↻•✕] /u, "")}{active.clinicorp_amount ? ` · ${formatCurrency(active.clinicorp_amount)}` : ""}
                    </span>
                  ) : "—"
                }
              />
              <Row label="Entrou em" value={formatDateBR(active.created_at)} />
            </div>
          </div>

          <div>
            <div className="mb-2 font-heading text-sm font-bold">Atendente responsável</div>
            <Select value={active.assigned_to ?? "none"} onValueChange={(v) => assign(v ?? "none")}>
              <SelectTrigger className="w-full">
                <SelectValue>{memberName(active.assigned_to)}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Sem atendente</SelectItem>
                {(members ?? []).map((m) => (
                  <SelectItem key={m.user_id} value={m.user_id}>
                    {m.display_name ?? m.user_id.slice(0, 8)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div>
            <div className="mb-2 font-heading text-sm font-bold">Tags</div>
            <div className="flex flex-wrap gap-1.5">
              {(active.tags ?? []).map((t) => (
                <Badge key={t} variant="secondary" className="gap-1">
                  {t}
                  <button onClick={() => removeTag(t)} className="text-muted-foreground hover:text-foreground">
                    <X className="h-3 w-3" />
                  </button>
                </Badge>
              ))}
              {(active.tags ?? []).length === 0 && (
                <span className="text-xs text-muted-foreground">Nenhuma tag</span>
              )}
            </div>
            <Input
              value={tagInput}
              onChange={(e) => setTagInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addTag(); } }}
              placeholder="+ tag e Enter"
              className="mt-2 h-8 text-sm"
            />
          </div>
        </div>
      )}

      </div>

      {/* Dialog gerenciar respostas rápidas */}
      <Dialog open={qrOpen} onOpenChange={setQrOpen}>
        <DialogContent className="gap-0 p-0">
          <DialogHeader className="border-b border-border px-6 py-4">
            <DialogTitle className="font-heading">Respostas rápidas</DialogTitle>
          </DialogHeader>
          <div className="max-h-[42vh] space-y-2 overflow-y-auto px-6 py-4">
            {(quickReplies ?? []).length === 0 && (
              <div className="text-sm text-muted-foreground">Nenhuma resposta rápida ainda. Crie a primeira abaixo — depois use digitando "/" no chat.</div>
            )}
            {(quickReplies ?? []).map((r) => (
              <div key={r.id} className="flex items-start justify-between gap-3 rounded-lg bg-bg-tertiary p-3">
                <div className="min-w-0 text-sm">
                  <div className="font-semibold">/{r.shortcut}</div>
                  <div className="text-muted-foreground">{r.content}</div>
                </div>
                <button onClick={() => deleteQuickReply(r.id)} className="shrink-0 text-muted-foreground hover:text-red-400">
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>
          <div className="space-y-3 border-t border-border px-6 py-4">
            <div className="grid grid-cols-[130px_1fr] gap-3">
              <div className="space-y-1.5">
                <Label>Atalho</Label>
                <Input value={qrForm.shortcut} onChange={(e) => setQrForm({ ...qrForm, shortcut: e.target.value })} placeholder="ola" />
              </div>
              <div className="space-y-1.5">
                <Label>Mensagem</Label>
                <Textarea rows={2} value={qrForm.content} onChange={(e) => setQrForm({ ...qrForm, content: e.target.value })} placeholder="Olá! Como posso ajudar? 😊" />
              </div>
            </div>
          </div>
          <DialogFooter className="border-t border-border px-6 py-4">
            <Button onClick={saveQuickReply}><Plus className="h-4 w-4" /> Adicionar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-right text-xs">{value}</span>
    </div>
  );
}
