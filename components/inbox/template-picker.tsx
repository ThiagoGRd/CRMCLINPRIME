"use client";
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { createClient } from '@/lib/supabase/client';
import { useOrg } from '@/components/org-context';
import { renderTextTemplate, type TextTemplate, type TemplateIntent } from '@/supabase/functions/_shared/whatsapp-policy';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';

type Catalog = {templates:TextTemplate[];checked_at:string};
export function TemplatePicker({conversationId,channelId,disabled,onSend}:{conversationId:string;channelId:string;disabled:boolean;onSend:(template:TemplateIntent)=>Promise<boolean>}) {
  const org=useOrg(); const supabase=useMemo(()=>createClient(),[]);
  const [open,setOpen]=useState(false); const [selected,setSelected]=useState('');
  const [header,setHeader]=useState<string[]>([]); const [body,setBody]=useState<string[]>([]); const [busy,setBusy]=useState(false);
  const catalog=useQuery({queryKey:['whatsapp-templates',org.id,conversationId,channelId],enabled:open,staleTime:0,refetchOnMount:'always',queryFn:async()=>{
    const {data,error}=await supabase.functions.invoke('whatsapp-templates',{body:{conversation_id:conversationId,channel_id:channelId}});
    if(error){const detail=await (error as {context?:Response}).context?.json?.().catch(()=>null);throw new Error(detail?.error??'Não foi possível consultar os templates deste número.');}
    if(!Array.isArray(data?.templates))throw new Error('Catálogo de templates inválido. Atualize antes de enviar.');
    return data as Catalog;
  }});
  const template=catalog.data?.templates.find(row=>row.id===selected);
  let preview='';let validation='Selecione um template aprovado.';
  if(template)try {preview=renderTextTemplate(template,{header,body});validation='';}catch(error){validation=(error as Error).message;}
  function choose(id:string){const value=catalog.data?.templates.find(row=>row.id===id);setSelected(id);setHeader(Array(value?.header_parameter_count??0).fill(''));setBody(Array(value?.body_parameter_count??0).fill(''));}
  async function send(){if(!template||!preview||busy||disabled)return;setBusy(true);try{if(await onSend({name:template.name,language:template.language,header,body,preview})){setOpen(false);choose('');}}finally{setBusy(false);}}
  return <><Button variant="outline" size="sm" disabled={disabled} onClick={()=>{setOpen(true);void catalog.refetch();}}>Templates aprovados</Button>
    <Dialog open={open} onOpenChange={value=>{if(!busy)setOpen(value);}}><DialogContent showCloseButton={!busy} className="max-h-[90dvh] overflow-y-auto sm:max-w-lg"><DialogHeader><DialogTitle>Enviar template aprovado</DialogTitle></DialogHeader>
      <p className="text-sm text-muted-foreground">Catálogo do número desta conversa. Confira o texto completo antes de enviar. Somente templates de texto compatíveis são mostrados.</p>
      {catalog.isFetching&&<p>Atualizando catálogo...</p>}{catalog.error&&<p role="alert" className="text-red-400">{catalog.error.message}</p>}
      {!catalog.isFetching&&!catalog.error&&catalog.data?.templates.length===0&&<p>Nenhum template de texto aprovado e compatível disponível neste número.</p>}
      <label htmlFor="whatsapp-template">Template e idioma</label><select id="whatsapp-template" className="h-10 rounded border border-input bg-background px-2" value={selected} disabled={busy||catalog.isFetching||!!catalog.error} onChange={event=>choose(event.target.value)}><option value="">Escolha um template</option>{catalog.data?.templates.map(row=><option key={row.id} value={row.id}>{row.name} · {row.language}</option>)}</select>
      {template&&<><p className="whitespace-pre-wrap rounded bg-muted p-3 text-sm">{[template.header,template.body,template.footer].filter(Boolean).join('\n\n')}</p>{header.map((value,index)=><label key={`header-${index}`} className="text-sm">Cabeçalho: variável {index+1}<Input aria-label={`Cabeçalho variável ${index+1}`} maxLength={60} value={value} disabled={busy} onChange={event=>setHeader(rows=>rows.map((row,i)=>i===index?event.target.value:row))}/></label>)}{body.map((value,index)=><label key={`body-${index}`} className="text-sm">Mensagem: variável {index+1}<Input aria-label={`Mensagem variável ${index+1}`} maxLength={1024} value={value} disabled={busy} onChange={event=>setBody(rows=>rows.map((row,i)=>i===index?event.target.value:row))}/></label>)}</>}
      {validation?<p className="text-xs text-muted-foreground">{validation}</p>:<div><h4 className="mb-2 font-semibold">Prévia do envio</h4><p className="whitespace-pre-wrap break-words rounded border border-border p-3">{preview}</p></div>}
      <DialogFooter><Button variant="outline" disabled={busy} onClick={()=>setOpen(false)}>Voltar</Button><Button disabled={disabled||busy||!!validation||catalog.isFetching||!!catalog.error} onClick={()=>void send()}>{busy?'Enviando...':'Confirmar e enviar template'}</Button></DialogFooter>
    </DialogContent></Dialog></>;
}
