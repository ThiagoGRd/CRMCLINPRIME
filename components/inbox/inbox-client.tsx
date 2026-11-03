"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { useOrg } from "@/components/org-context";
import { CC_BADGE } from "@/lib/funil";
import { formatPhoneDisplay, formatCurrency, formatDateBR } from "@/lib/format";
import { INBOXES, resolveInboxSelection, conversationFromLink, filterConversations, mergeConversationMessage, restoreFailedDraft, type InboxKey } from "@/lib/inbox";
import { classifySendResult, hasUnknownOutboundMarker, readOutboundMarkers, persistOutboundMarker, removeOutboundMarker, hasUnresolvedDuplicate, isUnresolvedOutbound, mergeOutboundAttempts, type OutboundAttempt, type OutboundState, type SendIntent } from "@/lib/outbound";
import { PendingItemsPanel } from "@/components/pendencias/pending-items-panel";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Send, Search, Zap, X, PanelRight, Plus, Trash2, RefreshCw } from "lucide-react";
import { toast } from "sonner";

type Patient = { id: string; name: string; phone: string | null; tags: string[] | null; treatment_interest: string | null; source: string | null; clinicorp_status: string | null; clinicorp_amount: number | null; created_at: string | null };
type Channel = { id: string; type: string; display_name: string; status: string; inbox_key: InboxKey | null; config: { display_phone?: string } | null; phone_number_id: string | null };
type Conversation = Patient & { id: string; patient_id: string; channel_id: string; assigned_to: string | null; status: string; last_message_at: string | null; inbox_key: InboxKey | null; channel: Channel };
type Message = { id: string; patient_id: string; conversation_id: string; channel_id: string; direction: string; content: string; created_at: string; status: string | null };
type Member = { user_id: string; display_name: string | null };
type QuickReply = { id: string; shortcut: string; content: string };
const selectClass = "h-9 w-full rounded-md border border-input bg-background px-2 text-sm";

export function InboxClient() {
  const org = useOrg();
  const qc = useQueryClient();
  const params = useSearchParams();
  const supabase = useMemo(() => createClient(), []);
  const [selection, setSelection] = useState<{ id: string | null; sector: InboxKey | 'unassigned'; linkKey: string } | null>(null);
  const [number, setNumber] = useState('all');
  const [search, setSearch] = useState('');
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [sendingIds, setSendingIds] = useState<Set<string>>(new Set());
  const inFlight = useRef(new Set<string>());
  const [attempts, setAttempts] = useState<Record<string, OutboundAttempt>>({});
  const [checkingIds, setCheckingIds] = useState<Set<string>>(new Set());
  const checking = useRef(new Set<string>());
  const [showPanel, setShowPanel] = useState(true);
  const [tagInput, setTagInput] = useState('');
  const [qrOpen, setQrOpen] = useState(false);
  const [qrSaving, setQrSaving] = useState(false);
  const [qrForm, setQrForm] = useState({ shortcut: '', content: '' });
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const channelQuery = useQuery({
    queryKey: ['inbox-channels', org.id],
    queryFn: async () => {
      const {data, error} = await supabase.from('channels').select('id,type,display_name,status,inbox_key,config,phone_number_id').eq('org_id', org.id).order('created_at');
      if (error) throw error;
      return (data ?? []) as Channel[];
    },
  });
  const conversationQuery = useQuery({
    queryKey: ['inbox-conversations', org.id],
    queryFn: async () => {
      const result: Conversation[] = [];
      for (let start = 0;; start += 500) {
        const {data, error} = await supabase.from('crm_conversations')
          .select('id,patient_id,channel_id,assigned_to,status,last_message_at,patient:crm_patients(id,name,phone,tags,treatment_interest,source,clinicorp_status,clinicorp_amount,created_at),channel:channels(id,type,display_name,status,inbox_key,config,phone_number_id)')
          .eq('org_id', org.id).order('last_message_at', {ascending: false, nullsFirst: false}).order('id').range(start, start + 499);
        if (error) throw error;
        for (const row of data ?? []) {
          const patient = row.patient as unknown as Patient | null;
          const channel = row.channel as unknown as Channel | null;
          if (patient && channel) result.push({...patient, id: row.id, patient_id: row.patient_id, channel_id: row.channel_id, assigned_to: row.assigned_to, status: row.status, last_message_at: row.last_message_at, inbox_key: channel.inbox_key, channel});
        }
        if (!data || data.length < 500) break;
      }
      return result;
    },
  });
  const {data: members = []} = useQuery({
    queryKey: ['org-members', org.id],
    queryFn: async () => {
      const {data, error} = await supabase.from('org_members').select('user_id,display_name').eq('org_id', org.id).order('created_at');
      if (error) throw error;
      return (data ?? []) as Member[];
    },
  });
  const {data: quickReplies = []} = useQuery({
    queryKey: ['quick-replies', org.id],
    queryFn: async () => {
      const {data, error} = await supabase.from('quick_replies').select('id,shortcut,content').eq('org_id', org.id).order('shortcut');
      if (error) throw error;
      return (data ?? []) as QuickReply[];
    },
  });
  const convs = conversationQuery.data ?? [];
  const linkedId = conversationFromLink(convs, params.get('c') ?? params.get('conversation'), params.get('p'));
  const linkKey = params.toString();
  const currentSelection = selection?.linkKey === linkKey ? selection : null;
  const {id: activeId, sector} = resolveInboxSelection(convs, selection, linkKey, params.get('c') ?? params.get('conversation'), params.get('p'));
  const active = convs.find(c => c.id === activeId);
  const text = activeId ? drafts[activeId] ?? '' : '';
  const channels = channelQuery.data ?? [];
  const sectorChannels = channels.filter(c => sector === 'unassigned' ? !c.inbox_key : c.inbox_key === sector);
  const filteredConvs = filterConversations(convs, sector, number, search);
  const memberName = (id: string | null) => members.find(m => m.user_id === id)?.display_name ?? 'Sem atendente';
  const outboundQuery = useQuery({
    queryKey: ['outbound-requests', org.id, activeId],
    enabled: !!activeId,
    refetchInterval: 15000,
    queryFn: async () => {
      const all: OutboundAttempt[] = [];
      for (let start = 0;; start += 500) {
        const {data,error} = await supabase.from('crm_outbound_requests')
          .select('request_id,conversation_id,channel_id,content,state,failure_code')
          .eq('org_id',org.id).eq('conversation_id',activeId!)
          .in('state',['pending','in_flight','uncertain']).order('created_at').order('request_id').range(start,start+499);
        if (error) throw error;
        all.push(...(data ?? []).map(row => ({request_id:row.request_id,conversation_id:row.conversation_id,channel_id:row.channel_id,text:row.content,state:row.state as OutboundState,error:'Envio pendente de confirmação. Nenhum reenvio automático será feito.'})));
        if (!data || data.length < 500) break;
      }
      return all;
    },
  });
  const recoveryQuery = useQuery({
    queryKey: ['outbound-recovery',org.id,activeId],
    staleTime: 0,
    refetchOnMount: 'always',
    enabled: !!activeId,
    refetchInterval: 15000,
    queryFn: async () => {
      const {data:{session},error} = await supabase.auth.getSession();
      if (error || !session?.user.id) throw new Error('Não foi possível verificar a sessão para proteger o envio.');
      const scope={orgId:org.id,userId:session.user.id};
      const markers=readOutboundMarkers(localStorage,scope).filter(row=>row.conversation_id===activeId);
      const restored: OutboundAttempt[]=[];
      for (const marker of markers) {
        const intent={request_id:marker.request_id,conversation_id:marker.conversation_id,channel_id:marker.channel_id,text:''};
        let value: unknown=null;
        try {value=await invokeSend({request_id:marker.request_id,action:'status'});} catch { /* Retain identity after a read failure. */ }
        const result=classifySendResult(intent,value);
        if (result.state==='sent' || result.state==='failed') removeOutboundMarker(localStorage,scope,marker.request_id);
        else restored.push({...intent,state:result.state,error:result.error});
      }
      return {scope,restored};
    },
  });
  const allAttempts = mergeOutboundAttempts(mergeOutboundAttempts(recoveryQuery.data?.restored ?? [],outboundQuery.data ?? []),Object.values(attempts));
  const visibleAttempts = allAttempts.filter(row => row.conversation_id === activeId && isUnresolvedOutbound(row));
  const unknownRestoredAttempt=visibleAttempts.some(row=>!row.text);

  const duplicateDraft = !!active && hasUnresolvedDuplicate(visibleAttempts,{conversation_id:active.id,channel_id:active.channel_id,text});
  const routeReady = active?.channel.type === 'whatsapp_cloud' && active.channel.status === 'connected' && !!active.channel.phone_number_id && !!active.inbox_key;
  const canSend = routeReady && !outboundQuery.isPending && !outboundQuery.error && !recoveryQuery.isPending && !recoveryQuery.error && !unknownRestoredAttempt;
  const updateDraft = (value: string) => { if (activeId) setDrafts(prev => ({...prev, [activeId]: value})); };
  const refreshConversations = () => qc.invalidateQueries({queryKey: ['inbox-conversations', org.id]});

  const messagesQuery = useQuery({
    queryKey: ['inbox-messages', org.id, activeId],
    enabled: !!activeId,
    queryFn: async () => {
      const all: Message[] = [];
      for (let start = 0;; start += 500) {
        const {data, error} = await supabase.from('crm_messages').select('id,patient_id,conversation_id,channel_id,direction,content,created_at,status')
          .eq('org_id', org.id).eq('conversation_id', activeId!).order('created_at').order('id').range(start, start + 499);
        if (error) throw error;
        all.push(...(data ?? []) as Message[]);
        if (!data || data.length < 500) break;
      }
      return all;
    },
  });
  const messages = messagesQuery.data ?? [];
  useEffect(() => {bottomRef.current?.scrollIntoView({behavior: 'smooth'});}, [messagesQuery.data]);

  useEffect(() => {
    let disposed = false;
    let channel: ReturnType<typeof supabase.channel> | null = null;
    void (async () => {
      const {data: {session}} = await supabase.auth.getSession();
      if (disposed) return;
      if (session) await supabase.realtime.setAuth(session.access_token);
      if (disposed) return;
      channel = supabase.channel(`inbox-${org.id}`)
        .on('postgres_changes', {event: '*', schema: 'public', table: 'crm_messages', filter: `org_id=eq.${org.id}`}, payload => {
          const row = payload.new as Message;
          if (row.conversation_id) void qc.invalidateQueries({queryKey: ['inbox-messages', org.id, row.conversation_id]});
          void qc.invalidateQueries({queryKey: ['inbox-conversations', org.id]});
        })
        .on('postgres_changes', {event: '*', schema: 'public', table: 'crm_conversations', filter: `org_id=eq.${org.id}`}, () => {void qc.invalidateQueries({queryKey: ['inbox-conversations', org.id]});})
        .subscribe();
    })();
    return () => {disposed = true; if (channel) void supabase.removeChannel(channel);};
  }, [supabase, qc, org.id]);

  async function recordSendResult(intent: SendIntent, value: unknown) {
    const result = classifySendResult(intent, value);
    setAttempts(previous => ({...previous,[intent.request_id]:{...intent,state:result.state,error:result.error}}));
    if ((result.state === 'sent' || result.state === 'failed') && recoveryQuery.data?.scope) {
      try {removeOutboundMarker(localStorage,recoveryQuery.data.scope,intent.request_id);} catch { /* Keep the marker for a later status-only recovery. */ }
      void qc.invalidateQueries({queryKey:['outbound-recovery',org.id,intent.conversation_id]});
    }
    if (result.state === 'sent') {
      const inserted = result.message as Message;
      qc.setQueryData<Message[]>(['inbox-messages',org.id,intent.conversation_id], previous => mergeConversationMessage(previous ?? [],inserted,intent.conversation_id));
      void refreshConversations();
      void qc.invalidateQueries({queryKey:['inbox-messages',org.id,intent.conversation_id]});
      void qc.invalidateQueries({queryKey:['outbound-requests',org.id,intent.conversation_id]});
    } else if (result.state === 'failed') {
      toast.error('Mensagem recusada', {description:result.error});
      if (intent.text) setDrafts(previous => restoreFailedDraft(previous,intent.conversation_id,intent.text));
    } else {
      toast.warning('Envio ainda não confirmado', {description:result.error});
    }
  }

  async function invokeSend(body: Record<string, unknown>) {
    const {data,error} = await supabase.functions.invoke('whatsapp-send',{body});
    if (!error) return data;
    const detail = await (error as {context?: Response}).context?.json?.().catch(() => null);
    return detail ?? null;
  }

  async function send() {
    if (!active || !text.trim() || !canSend || duplicateDraft || inFlight.current.has(active.id)) return;
    const conversation=active; const content=text.trim();
    let intent: SendIntent | null=null; let invoked=false;
    inFlight.current.add(conversation.id);
    setSendingIds(new Set(inFlight.current));
    try {
      // Do not trust a QueryClient cache across SPA navigation or a changed login.
      const {data:{session},error}=await supabase.auth.getSession();
      if (error || !session?.user.id) throw new Error('Sessão indisponível.');
      const scope={orgId:org.id,userId:session.user.id};
      if (scope.userId!==recoveryQuery.data?.scope.userId) {
        void qc.invalidateQueries({queryKey:['outbound-recovery',org.id]});
        toast.warning('A sessão mudou. Aguarde a conferência das tentativas antes de enviar.');
        return;
      }
      if (hasUnknownOutboundMarker(readOutboundMarkers(localStorage,scope),allAttempts,conversation.id)) {
        void qc.invalidateQueries({queryKey:['outbound-recovery',org.id,conversation.id]});
        toast.warning('Há uma tentativa anterior aguardando conferência. Nenhuma nova mensagem foi enviada.');
        return;
      }
      intent={request_id:crypto.randomUUID(),conversation_id:conversation.id,channel_id:conversation.channel_id,text:content};
      persistOutboundMarker(localStorage,scope,intent);
      const saved=intent;
      setAttempts(previous=>({...previous,[saved.request_id]:{...saved,state:'pending'}}));
      setDrafts(previous=>({...previous,[conversation.id]:''}));
      invoked=true;
      await recordSendResult(intent,await invokeSend(intent));
    } catch {
      if (intent && invoked) await recordSendResult(intent,null);
      else toast.error('Envio bloqueado: não foi possível proteger a tentativa neste navegador. Nenhuma mensagem foi enviada.');
    } finally {
      inFlight.current.delete(conversation.id);
      setSendingIds(new Set(inFlight.current));
    }
  }

  async function checkAttempt(intent: SendIntent) {
    if (checking.current.has(intent.request_id)) return;
    checking.current.add(intent.request_id);
    setCheckingIds(new Set(checking.current));
    try {
      // Status-only lookup: it must never send, claim or retry the original transport.
      await recordSendResult(intent,await invokeSend({request_id:intent.request_id,action:'status'}));
    } catch {
      toast.error('Não foi possível consultar a tentativa. Nenhum reenvio foi feito.');
    } finally {
      checking.current.delete(intent.request_id);
      setCheckingIds(new Set(checking.current));
    }
  }

  async function patchPatient(patientId: string, patch: Record<string, unknown>) {
    const {error} = await supabase.from('crm_patients').update(patch).eq('id', patientId).eq('org_id', org.id);
    if (error) toast.error('Erro ao salvar paciente', {description: error.message});
    else {toast.success('Paciente atualizado'); void refreshConversations();}
  }
  async function assign(id: string) {
    if (!active) return;
    const {error} = await supabase.from('crm_conversations').update({assigned_to: id || null}).eq('id', active.id).eq('org_id', org.id);
    if (error) toast.error('Erro ao atribuir conversa', {description: error.message});
    else void refreshConversations();
  }
  async function addTag() {
    if (!active || !tagInput.trim()) return;
    await patchPatient(active.patient_id, {tags: [...new Set([...(active.tags ?? []), tagInput.trim()])]});
    setTagInput('');
  }
  async function saveQuickReply() {
    const shortcut = qrForm.shortcut.trim().replace(/^\//, '');
    const content = qrForm.content.trim();
    if (!shortcut || !content || qrSaving) return;
    setQrSaving(true);
    const {error} = await supabase.from('quick_replies').insert({shortcut, content, org_id: org.id});
    setQrSaving(false);
    if (error) toast.error('Erro ao salvar resposta rápida', {description: error.message});
    else {setQrForm({shortcut: '', content: ''}); void qc.invalidateQueries({queryKey: ['quick-replies', org.id]});}
  }
  async function deleteQuickReply(id: string) {
    const {error} = await supabase.from('quick_replies').delete().eq('id', id).eq('org_id', org.id);
    if (error) toast.error('Erro ao excluir resposta rápida', {description: error.message});
    else void qc.invalidateQueries({queryKey: ['quick-replies', org.id]});
  }
  const qrFiltered = text.startsWith('/') ? quickReplies.filter(r => r.shortcut.toLowerCase().includes(text.slice(1).toLowerCase())).slice(0, 6) : [];
  const cc = active?.clinicorp_status ? CC_BADGE[active.clinicorp_status] : null;
  const error = conversationQuery.error ?? channelQuery.error;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2" role="tablist" aria-label="Caixas de atendimento">
        {INBOXES.map(item => <Button key={item.key} role="tab" aria-selected={sector === item.key} variant={sector === item.key ? 'default' : 'outline'} onClick={() => {setSelection({linkKey, id: null, sector: item.key}); setNumber('all'); setTagInput('');}}>{item.label}</Button>)}
        {channels.some(c => !c.inbox_key) && <Button role="tab" aria-selected={sector === 'unassigned'} variant={sector === 'unassigned' ? 'default' : 'outline'} onClick={() => {setSelection({linkKey, id: null, sector: 'unassigned'}); setNumber('all');}}>Sem setor</Button>}
        <Link href="/historico-legado" className="ml-auto text-sm text-primary underline">Histórico sem canal</Link>
        <Link href="/pendencias" className="text-sm text-primary underline">Ver todas as pendências</Link>
        <Button variant="ghost" size="icon" aria-label="Atualizar conversas" onClick={() => {void refreshConversations(); void channelQuery.refetch(); void messagesQuery.refetch();}}><RefreshCw className="h-4 w-4"/></Button>
      </div>
      {error && <div role="alert" className="rounded-lg border border-red-500/40 p-3 text-sm text-red-400">Não foi possível carregar as caixas. Verifique se a migração da base operacional foi aplicada no ambiente de teste. {error.message}</div>}
      {!currentSelection && params.get('p') && !linkedId && !conversationQuery.isPending && <div className="rounded-lg border border-amber-500/40 p-3 text-sm">Escolha o setor e a conversa deste paciente. Um link só com o paciente não escolhe um número automaticamente.</div>}
      {sector === 'unassigned' && <div className="text-sm text-amber-400">Classifique estes números em <Link href="/conexoes" className="underline">Conexões</Link> antes de responder. Mensagens antigas sem canal conhecido não são misturadas às caixas.</div>}
      <div className="flex min-h-[550px] flex-col gap-3 xl:h-[calc(100vh-230px)] xl:flex-row">
        <aside className="flex max-h-72 w-full shrink-0 flex-col rounded-xl xl:max-h-none xl:w-64 border border-border bg-card">
          <div className="space-y-2 p-3">
            <label className="text-xs text-muted-foreground" htmlFor="inbox-number">Número da caixa</label>
            <select id="inbox-number" className={selectClass} value={number} onChange={e => {setNumber(e.target.value); setSelection({linkKey, id: null, sector});}}><option value="all">Todos os números do setor</option>{sectorChannels.map(c => <option key={c.id} value={c.id}>{c.display_name} {c.config?.display_phone ?? ''}</option>)}</select>
            <div className="relative"><Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground"/><Input aria-label="Buscar conversa" value={search} onChange={e => setSearch(e.target.value)} placeholder="Nome ou telefone" className="pl-9"/></div>
          </div>
          <div className="flex-1 overflow-y-auto">
            {conversationQuery.isPending && <p className="p-4 text-sm text-muted-foreground">Carregando conversas...</p>}
            {!conversationQuery.isPending && !filteredConvs.length && <p className="p-4 text-sm text-muted-foreground">{sectorChannels.length ? 'Nenhuma conversa encontrada nesta caixa.' : 'Nenhum número vinculado a este setor. Configure em Conexões.'}</p>}
            {filteredConvs.map(c => <button key={c.id} onClick={() => {setSelection({linkKey, id: c.id, sector}); setTagInput('');}} className={`w-full border-b border-border px-3 py-3 text-left hover:bg-muted ${activeId === c.id ? 'bg-primary/10' : ''}`}><div className="truncate text-sm font-semibold">{c.name}</div><div className="text-xs text-muted-foreground">{formatPhoneDisplay(c.phone)}</div><div className="mt-1 truncate text-xs text-primary">{c.channel.display_name} · {c.channel.config?.display_phone ?? 'Número sem rótulo'}</div></button>)}
          </div>
        </aside>
        <section className="flex min-h-96 min-w-0 flex-1 flex-col rounded-xl border border-border bg-card" aria-label="Conversa selecionada">
          {!active ? <div className="flex flex-1 items-center justify-center p-5 text-center text-sm text-muted-foreground">Selecione uma conversa. Cada número mantém seu próprio histórico.</div> : <>
            <header className="flex items-center justify-between gap-2 border-b border-border p-4"><div className="min-w-0"><div className="truncate font-semibold">{active.name}</div><div className="text-xs text-muted-foreground">{formatPhoneDisplay(active.phone)} · {memberName(active.assigned_to)}</div><div className="mt-1 text-xs text-primary">Responder por: {active.channel.display_name} {active.channel.config?.display_phone ?? ''}</div></div><Button variant="ghost" size="icon" aria-label="Painel do paciente" onClick={() => setShowPanel(v => !v)}><PanelRight className="h-4 w-4"/></Button></header>
            <div className="flex-1 space-y-2 overflow-y-auto p-4" aria-live="polite">
              {messagesQuery.isPending && <p className="text-sm text-muted-foreground">Carregando histórico...</p>}
              {messagesQuery.error && <p role="alert" className="text-sm text-red-400">Erro ao carregar histórico: {messagesQuery.error.message}</p>}
              {!messagesQuery.isPending && !messagesQuery.error && !messages.length && <p className="text-sm text-muted-foreground">Nenhuma mensagem nesta conversa.</p>}
              {messages.map(m => <div key={m.id} className={`flex ${m.direction === 'outbound' ? 'justify-end' : 'justify-start'}`}><div className={`max-w-[85%] whitespace-pre-wrap rounded-xl px-3 py-2 text-sm ${m.direction === 'outbound' ? 'bg-primary text-primary-foreground' : 'bg-muted'}`}>{m.content}<div className="mt-1 text-right text-[10px] opacity-70">{new Date(m.created_at).toLocaleString('pt-BR')}{m.direction === 'outbound' && m.status ? ` · ${m.status}` : ''}</div></div></div>)}
              <div ref={bottomRef}/>
            </div>
            {qrFiltered.length > 0 && <div className="mx-3 rounded border border-border">{qrFiltered.map(r => <button key={r.id} onClick={() => {updateDraft(r.content); inputRef.current?.focus();}} className="block w-full p-2 text-left text-sm hover:bg-muted"><strong>/{r.shortcut}</strong> · {r.content.slice(0, 80)}</button>)}</div>}
            {recoveryQuery.error && <p role="alert" className="border-t border-border p-3 text-sm text-red-400">{recoveryQuery.error.message} O envio permanece bloqueado.</p>}
            {outboundQuery.error && <p role="alert" className="border-t border-border p-3 text-sm text-red-400">Não foi possível verificar as tentativas de envio. Atualize o histórico antes de responder.</p>}
            {visibleAttempts.length > 0 && <div role="status" className="space-y-2 border-t border-amber-500/40 p-3 text-sm"><p className="font-semibold text-amber-400">Há envios sem confirmação</p><p className="text-xs text-muted-foreground">Confira o recebimento antes de repetir. Consultar uma tentativa não envia mensagens. A mesma mensagem fica bloqueada enquanto houver dúvida.</p>{visibleAttempts.map(attempt => <div key={attempt.request_id} className="rounded border border-border p-2"><p className="whitespace-pre-wrap break-words">{attempt.text || 'Tentativa recuperada após recarga. O texto não é guardado neste navegador.'}</p><p className="my-1 text-xs text-muted-foreground">{attempt.error ?? 'Aguardando confirmação.'}</p><Button variant="outline" disabled={checkingIds.has(attempt.request_id) || sendingIds.has(attempt.conversation_id)} onClick={() => void checkAttempt(attempt)}>Consultar tentativa</Button></div>)}</div>}
            {unknownRestoredAttempt && <p className="px-3 py-2 text-xs text-amber-400">Uma tentativa anterior ainda não foi localizada ou confirmada. Novos envios nesta conversa estão bloqueados para evitar duplicação.</p>}
            {duplicateDraft && <p className="px-3 py-2 text-xs text-amber-400">Esta mensagem já tem uma tentativa sem confirmação. Consulte-a acima, sem reenviar.</p>}
            {!routeReady && <p className="border-t border-border px-3 py-2 text-xs text-amber-400">Envio indisponível: este número precisa de setor definido, conexão ativa e integração oficial compatível. Nenhum outro número será usado.</p>}
            <div className="flex gap-2 border-t border-border p-3"><Button variant="ghost" size="icon" aria-label="Respostas rápidas" onClick={() => setQrOpen(true)}><Zap className="h-4 w-4"/></Button><Input ref={inputRef} aria-label="Mensagem" value={text} onChange={e => updateDraft(e.target.value)} maxLength={4096} onKeyDown={e => {if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && !qrFiltered.length) {e.preventDefault(); void send();}}} placeholder="Mensagem (/ para respostas rápidas)"/><Button size="icon" aria-label="Enviar mensagem" onClick={() => void send()} disabled={!canSend || duplicateDraft || sendingIds.has(active.id) || !text.trim()}><Send className="h-4 w-4"/></Button></div>
          </>}
        </section>
        {active && showPanel && <aside className="flex w-full shrink-0 flex-col gap-5 xl:w-80 overflow-y-auto rounded-xl border border-border bg-card p-4">
          <div><h2 className="text-sm font-semibold">Paciente</h2><div className="mt-2 space-y-2 text-xs"><p>{formatPhoneDisplay(active.phone)}</p><p>{active.treatment_interest || active.source || 'Sem interesse informado'}</p>{cc && <p style={{color: cc.color}}>{cc.label} {formatCurrency(active.clinicorp_amount ?? 0)}</p>}<p>Cadastro: {formatDateBR(active.created_at)}</p><Link href={`/historico-legado?p=${encodeURIComponent(active.patient_id)}`} className="text-primary underline">Consultar histórico antigo sem canal</Link></div></div>
          <div><label htmlFor="inbox-assignee" className="mb-2 block text-sm font-semibold">Responsável pela conversa</label><select id="inbox-assignee" className={selectClass} value={active.assigned_to ?? ''} onChange={e => void assign(e.target.value)}><option value="">Sem atendente</option>{members.map(m => <option key={m.user_id} value={m.user_id}>{m.display_name ?? m.user_id.slice(0, 8)}</option>)}</select></div>
          <div><h2 className="mb-2 text-sm font-semibold">Tags do paciente</h2><div className="flex flex-wrap gap-1">{(active.tags ?? []).map(tag => <Badge key={tag} variant="secondary">{tag}<button aria-label={`Remover tag ${tag}`} onClick={() => void patchPatient(active.patient_id, {tags: (active.tags ?? []).filter(t => t !== tag)})}><X className="h-3 w-3"/></button></Badge>)}</div><Input aria-label="Nova tag" value={tagInput} onChange={e => setTagInput(e.target.value)} onKeyDown={e => {if (e.key === 'Enter') {e.preventDefault(); void addTag();}}} placeholder="+ tag e Enter" className="mt-2"/></div>
          <PendingItemsPanel key={active.id} patientId={active.patient_id} conversationId={active.id}/>
        </aside>}
      </div>
      <Dialog open={qrOpen} onOpenChange={setQrOpen}><DialogContent><DialogHeader><DialogTitle>Respostas rápidas</DialogTitle></DialogHeader><div className="max-h-[40vh] space-y-2 overflow-auto">{quickReplies.map(r => <div key={r.id} className="flex gap-2 rounded bg-muted p-3"><div className="flex-1 text-sm"><strong>/{r.shortcut}</strong><p>{r.content}</p></div><Button variant="ghost" size="icon" aria-label={`Excluir resposta ${r.shortcut}`} onClick={() => void deleteQuickReply(r.id)}><Trash2 className="h-4 w-4"/></Button></div>)}</div><Label htmlFor="quick-shortcut">Atalho</Label><Input id="quick-shortcut" value={qrForm.shortcut} onChange={e => setQrForm({...qrForm, shortcut: e.target.value})}/><Label htmlFor="quick-content">Mensagem</Label><Textarea id="quick-content" value={qrForm.content} onChange={e => setQrForm({...qrForm, content: e.target.value})}/><DialogFooter><Button onClick={() => void saveQuickReply()} disabled={qrSaving || !qrForm.shortcut.trim() || !qrForm.content.trim()}><Plus className="h-4 w-4"/>Adicionar</Button></DialogFooter></DialogContent></Dialog>
    </div>
  );
}
