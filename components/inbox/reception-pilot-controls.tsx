"use client";
import type {PilotController} from '../../lib/reception-pilot-controller';
import {validBaileysText} from '../../lib/baileys-text-contract';
type Props={view:PilotController['view'];text:string;setText:(text:string)=>void;send:()=>void;recover:()=>void;newMessage:()=>void};
const states={recorded:'Registrado; envio bloqueado',dispatching:'Tentativa em andamento; envio bloqueado',uncertain:'Resultado incerto; não reenvie',api_accepted:'API aceitou. Entrega e leitura não verificadas.',rejected_before_dispatch:'Rejeitado antes do envio. Nenhuma tentativa no provedor.'};
export function ReceptionPilotControls({view,text,setText,send,recover,newMessage}:Props){
 if(!view.context)return null;
 return <details className="shrink-0 rounded border border-amber-300 bg-amber-50 p-2 text-sm text-slate-900">
  <summary className="cursor-pointer font-medium">Recepção · piloto de teste</summary>
  <div className="max-h-56 overflow-y-auto space-y-2 pt-2">
   <p>Destino fixo aprovado: <strong>{view.context.recipientLabel}</strong>. Independente do paciente aberto no Inbox.</p>
   <p>Somente texto, até 1024 bytes. Não grava histórico no CRM.</p>
   <textarea aria-label="Mensagem de teste da Recepção" className="w-full rounded border p-2" rows={2} maxLength={1024} value={text} disabled={!view.canSend||view.busy} onChange={e=>setText(e.target.value)}/>
   <div className="flex flex-wrap gap-2">
    <button type="button" className="rounded border px-2 py-1 disabled:opacity-50" disabled={!view.canSend||view.busy||!validBaileysText(text)} onClick={send}>Enviar teste</button>
    <button type="button" className="rounded border px-2 py-1 disabled:opacity-50" disabled={view.busy} onClick={recover}>Consultar estado (sem reenviar)</button>
    {view.canNew&&<button type="button" className="rounded border px-2 py-1" onClick={newMessage}>Criar nova mensagem explicitamente</button>}
   </div>
   <p role="status">{view.busy?'Consultando ou processando a tentativa atual. Aguarde; não reenvie.':view.error??(view.result?states[view.result.state]:'Nova mensagem pronta para um teste no destino fixo.')}</p>
  </div>
 </details>;
}
