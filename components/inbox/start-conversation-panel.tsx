"use client";

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { MessageSquarePlus } from 'lucide-react';
import { toast } from 'sonner';
import { useOrg } from '@/components/org-context';
import { createClient } from '@/lib/supabase/client';
import { INBOXES } from '@/lib/inbox';
import { formatPhoneDisplay } from '@/lib/format';
import { conversationChannelProblem, getConversationPatient, openConversation, searchConversationPatients, type OpenedConversation, type StartConversationChannel } from '@/lib/start-conversation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

type Props={patientId?:string|null;onCreated:(conversation:OpenedConversation)=>void|Promise<void>};
const selectClass='h-10 w-full rounded-md border border-input bg-background px-2 text-sm';

/** Opens a CRM record only. The inbox owns all subsequent sending/template policy. */
export function StartConversationPanel({patientId,onCreated}:Props) {
  const org=useOrg();
  const [open,setOpen]=useState(false);const [busy,setBusy]=useState(false);
  return <>
    <Button size="sm" variant="outline" onClick={()=>setOpen(true)}><MessageSquarePlus className="h-4 w-4"/>{patientId?'Abrir conversa para este paciente':'Abrir conversa'}</Button>
    <Dialog open={open} onOpenChange={next=>{if(!busy)setOpen(next);}}>
      <DialogContent className="sm:max-w-lg" showCloseButton={!busy}>
        <DialogHeader><DialogTitle>Abrir conversa</DialogTitle><DialogDescription>Escolha o paciente e o número de atendimento. Abrir uma conversa não envia nenhuma mensagem.</DialogDescription></DialogHeader>
        {open&&<StartConversationForm key={`${org.id}:${patientId??''}`} patientId={patientId} onBusyChange={setBusy}
          onCancel={()=>setOpen(false)} onCreated={conversation=>{setOpen(false);return onCreated(conversation);}}/>}
      </DialogContent>
    </Dialog>
  </>;
}

function StartConversationForm({patientId,onCreated,onCancel,onBusyChange}:Props&{onCancel:()=>void;onBusyChange:(busy:boolean)=>void}) {
  const org=useOrg();const qc=useQueryClient();const client=useMemo(()=>createClient(),[]);const fieldId=useId();
  const [search,setSearch]=useState('');const [query,setQuery]=useState('');
  const [selectedPatientId,setSelectedPatientId]=useState(patientId??'');const [channelId,setChannelId]=useState('');
  const [busy,setBusy]=useState(false);const [error,setError]=useState<string|null>(null);const lock=useRef(false);const mounted=useRef(true);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;onBusyChange(false);};},[onBusyChange]);
  useEffect(()=>{const timer=setTimeout(()=>setQuery(search),200);return()=>clearTimeout(timer);},[search]);
  const patients=useQuery({queryKey:['start-conversation-patients',org.id,query],queryFn:()=>searchConversationPatients(client,org.id,query)});
  const patient=useQuery({queryKey:['start-conversation-patient',org.id,selectedPatientId],enabled:!!selectedPatientId,
    queryFn:()=>getConversationPatient(client,org.id,selectedPatientId)});
  const channels=useQuery({queryKey:['start-conversation-channels',org.id],queryFn:async()=>{
    const all:StartConversationChannel[]=[];
    for(let offset=0;;offset+=500){
      const {data,error}=await client.from('channels').select('id,org_id,type,display_name,status,inbox_key,phone_number_id,config')
        .eq('org_id',org.id).order('created_at').order('id').range(offset,offset+499);
      if(error)throw error;
      if(data?.some(row=>row.org_id!==org.id))throw new Error('Número indisponível nesta organização.');
      all.push(...(data??[]) as StartConversationChannel[]);
      if(!data||data.length<500)break;
    }
    return all;
  }});
  const channel=channels.data?.find(row=>row.id===channelId);
  const channelProblem=conversationChannelProblem(channel);
  const ready=!!patient.data&&!patient.error&&!channels.error&&!channelProblem;
  async function submit(){
    if(lock.current||!ready)return;
    lock.current=true;setBusy(true);onBusyChange(true);setError(null);
    try{
      const conversation=await openConversation(client,{orgId:org.id,patientId:selectedPatientId,channelId});
      await qc.invalidateQueries({queryKey:['inbox-conversations',org.id]});
      if(!mounted.current)return;
      toast.success('Conversa aberta. Nenhuma mensagem foi enviada.');
      await onCreated(conversation);
    }catch(error){if(mounted.current)setError((error as Error).message||'Não foi possível abrir a conversa.');}
    finally{lock.current=false;if(mounted.current){setBusy(false);onBusyChange(false);}}
  }
  return <>
    <div className="space-y-2">
      <Label htmlFor={`${fieldId}-search`}>Buscar paciente</Label>
      <Input id={`${fieldId}-search`} placeholder="Nome ou telefone" value={search} maxLength={100} disabled={busy} onChange={event=>setSearch(event.target.value)}/>
      {patients.isPending&&<p className="text-xs text-muted-foreground">Buscando pacientes...</p>}
      {patients.error&&<p role="alert" className="text-xs text-red-400">Não foi possível buscar pacientes. <button className="underline" onClick={()=>void patients.refetch()}>Tentar novamente</button></p>}
      {!patients.error&&patients.data?.length===0&&<p className="text-xs text-muted-foreground">Nenhum paciente encontrado nesta organização.</p>}
      <div className="max-h-36 space-y-1 overflow-y-auto" aria-label="Pacientes encontrados">
        {patients.data?.map(row=><button type="button" key={row.id} disabled={busy} aria-pressed={selectedPatientId===row.id}
          className={`w-full rounded-md border px-3 py-2 text-left text-sm disabled:opacity-50 ${selectedPatientId===row.id?'border-primary bg-primary/10':'border-border hover:bg-muted'}`}
          onClick={()=>{setSelectedPatientId(row.id);setError(null);}}><span className="block font-medium">{row.name}</span><span className="text-xs text-muted-foreground">{row.phone?formatPhoneDisplay(row.phone):'Sem telefone cadastrado'}</span></button>)}
      </div>
      {(patients.data?.length??0)>=30&&<p className="text-xs text-muted-foreground">Mostrando até 30 pacientes. Refine a busca pelo nome ou telefone.</p>}
      {selectedPatientId&&(patient.isPending?<p className="text-xs text-muted-foreground">Consultando paciente selecionado...</p>:patient.error?<p role="alert" className="text-xs text-red-400">Não foi possível consultar este paciente. <button className="underline" onClick={()=>void patient.refetch()}>Tentar novamente</button></p>:patient.data?<p className="text-sm">Paciente selecionado: <strong>{patient.data.name}</strong> · {patient.data.phone?formatPhoneDisplay(patient.data.phone):'Sem telefone cadastrado'}</p>:<p role="alert" className="text-xs text-red-400">Paciente não encontrado nesta organização. Escolha um paciente da lista.</p>)}
    </div>
    <div className="space-y-2">
      <Label htmlFor={`${fieldId}-channel`}>Número de atendimento</Label>
      <select id={`${fieldId}-channel`} className={selectClass} value={channelId} disabled={busy||channels.isPending||!!channels.error} onChange={event=>{setChannelId(event.target.value);setError(null);}}>
        <option value="">Selecione o número e o setor</option>
        {channels.data?.map(row=>{const problem=conversationChannelProblem(row);const sector=INBOXES.find(item=>item.key===row.inbox_key)?.label??'Sem setor';return <option key={row.id} value={row.id} disabled={!!problem}>
          {sector} · {row.display_name}{row.config?.display_phone?` · ${row.config.display_phone}`:row.phone_number_id?` · ID ${row.phone_number_id}`:''}{problem?` · ${problem}`:row.status!=='connected'?' · Desconectado':''}
        </option>;})}
      </select>
      {channels.isPending&&<p className="text-xs text-muted-foreground">Carregando números...</p>}
      {channels.error&&<p role="alert" className="text-xs text-red-400">Não foi possível carregar os números. <button className="underline" onClick={()=>void channels.refetch()}>Tentar novamente</button></p>}
      {channels.data?.length===0&&<p className="text-xs text-muted-foreground">Nenhum número cadastrado nesta organização.</p>}
      {!!channels.data?.length&&channels.data.every(row=>conversationChannelProblem(row))&&<p className="text-xs text-muted-foreground">Nenhum número está identificado e classificado para abrir uma conversa.</p>}
      {channel&&channelProblem&&<p role="alert" className="text-xs text-red-400">{channelProblem}</p>}
      {channel&&!channelProblem&&channel.status!=='connected'&&<p className="text-xs text-amber-600 dark:text-amber-400">Este número está desconectado. Você pode abrir a conversa, mas o envio ficará bloqueado até a reconexão.</p>}
      {patient.data&&!patient.data.phone&&<p className="text-xs text-amber-600 dark:text-amber-400">O paciente está sem telefone. Cadastre um telefone antes de enviar mensagens.</p>}
      <p className="text-xs text-muted-foreground">Se já existir uma conversa neste número, ela será reutilizada. O envio seguirá as regras do WhatsApp, incluindo o uso de um modelo aprovado quando necessário.</p>
    </div>
    {error&&<p role="alert" className="text-sm text-red-400">{error}</p>}
    <DialogFooter><Button variant="outline" disabled={busy} onClick={onCancel}>Cancelar</Button><Button disabled={busy||!ready} onClick={()=>void submit()}>{busy?'Abrindo...':'Abrir conversa sem enviar'}</Button></DialogFooter>
  </>;
}
