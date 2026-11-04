"use client";

import { useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createClient } from '@/lib/supabase/client';
import { useOrg } from '@/components/org-context';
import { buildOutboundReview, type OutboundReviewOperation } from '@/lib/outbound-review';
import type { OutboundAttempt, SendIntent } from '@/lib/outbound';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { toast } from 'sonner';

type Audit = {id:string; request_id:string; actor_id:string; operation:OutboundReviewOperation; evidence:string; resulting_state:string; created_at:string};
const labels = {finalize:'Registrar mensagem aceita',cancel:'Cancelar tentativa não iniciada',observe:'Registrar observação'};
const descriptions = {
  finalize:'Usa apenas a aceitação já registrada pelo provedor para salvar a mensagem no CRM. Não envia outra mensagem e não confirma leitura ou entrega ao paciente.',
  cancel:'Só cancela se o envio ainda não começou. O servidor bloqueia a tentativa original caso ela chegue atrasada. Tentativas já iniciadas não podem ser canceladas aqui.',
  observe:'Registra sua conferência e mantém a tentativa sem confirmação. Uma observação não comprova entrega e não libera reenvio automático.',
};
export function OutboundReviewPanel({conversationId,attempts,memberName,onApplied}:{conversationId:string; attempts:OutboundAttempt[]; memberName:(id:string|null)=>string; onApplied:(intent:SendIntent,value:unknown)=>Promise<void>}) {
  const org=useOrg(); const qc=useQueryClient(); const supabase=useMemo(()=>createClient(),[]);
  const [selected,setSelected]=useState<OutboundAttempt|null>(null);
  const [operation,setOperation]=useState<OutboundReviewOperation>('observe');
  const [evidence,setEvidence]=useState(''); const [busy,setBusy]=useState(false); const lock=useRef(false);
  const [limit,setLimit]=useState(20);
  const audit=useQuery({queryKey:['outbound-reconciliations',org.id,conversationId,limit],queryFn:async()=>{
    const {data,error}=await supabase.from('crm_outbound_reconciliations').select('id,request_id,actor_id,operation,evidence,resulting_state,created_at')
      .eq('org_id',org.id).eq('conversation_id',conversationId).order('created_at',{ascending:false}).order('id',{ascending:false}).limit(limit+1);
    if(error)throw error;return (data??[]) as Audit[];
  }});
  async function submit() {
    if (!selected || lock.current) return;
    const intent=selected; let body;
    try {body=buildOutboundReview(intent.request_id,intent.conversation_id,operation,evidence);} catch(error) {toast.error((error as Error).message);return;}
    lock.current=true;setBusy(true);
    try {
      const {data,error}=await supabase.functions.invoke('whatsapp-send',{body});
      const failure=error ? await (error as {context?:Response}).context?.json?.().catch(()=>null) : null;
      if (error || !data?.reconciliation?.id || data.request_id!==intent.request_id || data.reconciliation.operation!==body.operation) {
        throw new Error(failure?.error ?? 'Não foi possível confirmar a conferência. Consulte o histórico antes de tentar novamente.');
      }
      await onApplied(intent,data);
      void qc.invalidateQueries({queryKey:['outbound-reconciliations',org.id,intent.conversation_id]});
      void qc.invalidateQueries({queryKey:['outbound-requests',org.id,intent.conversation_id]});
      setSelected(null);setEvidence('');toast.success('Conferência registrada com responsável e evidência.');
    } catch(error) {toast.error((error as Error).message);} finally {lock.current=false;setBusy(false);}
  }
  return <section className="space-y-2 border-t border-border p-3 text-sm" aria-label="Conferência auditada de envios">
    <h3 className="font-semibold">Conferência de envios</h3>
    {org.role==='admin' ? attempts.map(attempt=><div key={attempt.request_id} className="flex flex-wrap items-center justify-between gap-2 rounded border border-border p-2"><span className="break-all text-xs text-muted-foreground">Tentativa {attempt.request_id}</span><Button size="sm" variant="outline" onClick={()=>{setSelected(attempt);setOperation(attempt.provider_message_id?'finalize':!attempt.text || attempt.state==='pending'?'cancel':'observe');setEvidence('');}}>Conferir tentativa</Button></div>) : attempts.length>0 && <p className="text-xs text-muted-foreground">Peça a um administrador para conferir estas tentativas. Nenhum reenvio é feito automaticamente.</p>}
    {audit.isPending && <p className="text-xs text-muted-foreground">Carregando conferências...</p>}
    {audit.error && <p role="alert" className="text-xs text-red-400">Não foi possível carregar o histórico de conferências.</p>}
    {audit.data?.slice(0,limit).map(row=><article key={row.id} className="rounded border border-border p-2 text-xs"><p className="font-medium">{labels[row.operation]} · {memberName(row.actor_id)}</p><p className="text-muted-foreground">{new Date(row.created_at).toLocaleString('pt-BR')} · {row.actor_id}</p><p className="my-1 whitespace-pre-wrap break-words">{row.evidence}</p><p className="break-all text-muted-foreground">Tentativa {row.request_id} · Estado: {row.resulting_state}</p></article>)}
    {audit.data?.length===0 && <p className="text-xs text-muted-foreground">Nenhuma conferência registrada nesta conversa.</p>}
    {(audit.data?.length??0)>limit && <Button size="sm" variant="outline" onClick={()=>setLimit(value=>value+20)}>Ver conferências anteriores</Button>}
    <Dialog open={!!selected} onOpenChange={open=>{if(!open&&!lock.current)setSelected(null);}}><DialogContent showCloseButton={!busy}><DialogHeader><DialogTitle>Conferir tentativa de envio</DialogTitle></DialogHeader>
      <p className="break-all text-xs text-muted-foreground">{selected?.request_id}</p>
      <label htmlFor="outbound-review-operation">Ação</label><select id="outbound-review-operation" className="h-10 rounded border border-input bg-background px-2" value={operation} disabled={busy} onChange={event=>setOperation(event.target.value as OutboundReviewOperation)}>
        <option value="observe">{labels.observe}</option><option value="cancel">{labels.cancel}</option><option value="finalize" disabled={!selected?.provider_message_id}>{labels.finalize}</option>
      </select><p className="text-sm text-muted-foreground">{descriptions[operation]}</p>
      <label htmlFor="outbound-review-evidence">O que foi conferido e qual é a evidência?</label><Textarea id="outbound-review-evidence" value={evidence} disabled={busy} onChange={event=>setEvidence(event.target.value)} maxLength={2000} placeholder="Descreva a verificação realizada. Não inclua senhas ou dados sensíveis desnecessários."/>
      <DialogFooter><Button variant="outline" disabled={busy} onClick={()=>setSelected(null)}>Voltar</Button><Button disabled={busy||!evidence.trim()} onClick={()=>void submit()}>{busy?'Registrando...':'Confirmar conferência'}</Button></DialogFooter>
    </DialogContent></Dialog>
  </section>;
}
