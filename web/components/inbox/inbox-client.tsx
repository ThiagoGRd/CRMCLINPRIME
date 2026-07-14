"use client";

import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useOrg } from "@/components/org-context";
import { formatPhoneDisplay } from "@/lib/format";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Send, Search, Bot, User } from "lucide-react";
import { toast } from "sonner";

type Conversation = {
  id: string;
  name: string;
  phone: string | null;
  tags: string[] | null;
  last_message_at: string | null;
};
type Message = {
  id: string;
  patient_id: string;
  direction: string;
  content: string;
  created_at: string;
};

export function InboxClient() {
  const org = useOrg();
  const searchParams = useSearchParams();
  const [convs, setConvs] = useState<Conversation[]>([]);
  const [search, setSearch] = useState("");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [aiPaused, setAiPaused] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const activeIdRef = useRef<string | null>(null);
  activeIdRef.current = activeId;

  const supabase = useMemo(() => createClient(), []);

  // Carrega a lista de conversas
  const loadConversations = useCallback(async () => {
    const { data } = await supabase
      .from("patients")
      .select("id,name,phone,tags,last_message_at")
      .order("last_message_at", { ascending: false, nullsFirst: false })
      .limit(80);
    setConvs((data ?? []) as Conversation[]);
  }, [supabase]);

  useEffect(() => { loadConversations(); }, [loadConversations]);

  // Seleção inicial via ?p=
  useEffect(() => {
    const p = searchParams.get("p");
    if (p) setActiveId(p);
  }, [searchParams]);

  // Carrega histórico da conversa ativa + status IA
  useEffect(() => {
    if (!activeId) { setMessages([]); return; }
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from("messages")
        .select("id,patient_id,direction,content,created_at")
        .eq("patient_id", activeId)
        .order("created_at", { ascending: true });
      if (!cancelled) setMessages((data ?? []) as Message[]);

      const conv = convs.find((c) => c.id === activeId);
      const phone = (conv?.phone ?? "").replace(/\D/g, "");
      if (phone) {
        const { data: chat } = await supabase
          .from("chats").select("ai_service").eq("phone", phone).maybeSingle();
        if (!cancelled) setAiPaused(chat?.ai_service === "pause");
      }
    })();
    return () => { cancelled = true; };
  }, [activeId, supabase, convs]);

  // Autoscroll
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
          { event: "INSERT", schema: "public", table: "crm_messages" },
          (payload) => {
            const row = payload.new as Message;
            if (row.patient_id === activeIdRef.current) {
              setMessages((prev) =>
                prev.some((m) => m.id === row.id) ? prev : [...prev, row]
              );
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
      const { data: sendRes, error: fnErr } = await supabase.functions.invoke("evolution-proxy", {
        body: { action: "send_text", payload: { phone: conv.phone, text: content, org_id: org.id } },
      });
      if (fnErr || sendRes?.error) throw new Error(sendRes?.error ?? fnErr?.message ?? "falha no envio");

      const { data: inserted } = await supabase
        .from("messages")
        .insert({ patient_id: activeId, direction: "outbound", content, message_type: "text", status: "sent", org_id: org.id })
        .select("id,patient_id,direction,content,created_at")
        .single();
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
    const { error } = await supabase.from("chats").update({ ai_service: next }).eq("phone", phone);
    if (error) { setAiPaused(aiPaused); toast.error("Erro ao alterar IA"); }
    else toast.success(next === "pause" ? "Você assumiu o atendimento" : "IA reativada");
  }

  const filteredConvs = search.trim()
    ? convs.filter((c) => c.name?.toLowerCase().includes(search.toLowerCase()) || (c.phone ?? "").includes(search))
    : convs;
  const active = convs.find((c) => c.id === activeId);

  return (
    <div className="flex h-[calc(100vh-160px)] gap-4">
      {/* Lista de conversas */}
      <div className="flex w-80 shrink-0 flex-col rounded-xl border border-border bg-card">
        <div className="relative p-3">
          <Search className="pointer-events-none absolute left-6 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar conversa..." className="pl-9" />
        </div>
        <div className="flex-1 overflow-y-auto">
          {filteredConvs.map((c) => (
            <button
              key={c.id}
              onClick={() => setActiveId(c.id)}
              className={`flex w-full items-center gap-3 border-b border-white/[.04] px-3 py-3 text-left transition-colors hover:bg-white/[.03] ${
                activeId === c.id ? "bg-primary/10" : ""
              }`}
            >
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-primary to-emerald-500 text-xs font-bold text-white">
                {(c.name ?? "?").slice(0, 2).toUpperCase()}
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{c.name}</div>
                <div className="truncate text-xs text-muted-foreground">{formatPhoneDisplay(c.phone)}</div>
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Conversa ativa */}
      <div className="flex min-w-0 flex-1 flex-col rounded-xl border border-border bg-card">
        {!active ? (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
            Selecione uma conversa
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
              <div>
                <div className="font-heading font-semibold">{active.name}</div>
                <div className="text-xs text-muted-foreground">{formatPhoneDisplay(active.phone)}</div>
              </div>
              <Button variant={aiPaused ? "default" : "outline"} size="sm" onClick={toggleAi}>
                {aiPaused ? <User className="h-4 w-4" /> : <Bot className="h-4 w-4" />}
                {aiPaused ? "Você atendendo" : "IA ativa"}
              </Button>
            </div>

            <div className="flex-1 space-y-2 overflow-y-auto px-5 py-4">
              {messages.length === 0 && (
                <div className="py-8 text-center text-sm text-muted-foreground">
                  Nenhuma mensagem ainda.
                </div>
              )}
              {messages.map((m) => {
                const out = m.direction === "outbound";
                return (
                  <div key={m.id} className={`flex ${out ? "justify-end" : "justify-start"}`}>
                    <div
                      className={`max-w-[70%] rounded-2xl px-3.5 py-2 text-sm ${
                        out ? "bg-primary text-primary-foreground" : "bg-bg-tertiary text-foreground"
                      }`}
                    >
                      {m.content}
                    </div>
                  </div>
                );
              })}
              <div ref={bottomRef} />
            </div>

            <div className="flex items-center gap-2 border-t border-border p-3">
              <Input
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
                placeholder="Digite uma mensagem..."
              />
              <Button onClick={send} disabled={sending || !text.trim()} size="icon">
                <Send className="h-4 w-4" />
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
