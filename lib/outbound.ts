export type SendIntent = { request_id: string; conversation_id: string; channel_id: string; text: string };
export type OutboundState = 'pending' | 'in_flight' | 'sent' | 'failed' | 'uncertain';
export type OutboundAttempt = SendIntent & { state: OutboundState; error?: string };
export type SentMessage = { id: string; conversation_id: string; channel_id: string };
export type SendResult = { state: OutboundState; error?: string; message?: SentMessage };
const unknownMessage = 'O recebimento não foi confirmado. Consulte esta tentativa antes de repetir a mensagem.';

// Unknown responses are not proof of rejection: retain the intent and never retry transport automatically.
export function classifySendResult(intent: SendIntent, value: unknown): SendResult {
  if (!value || typeof value !== 'object') return {state:'uncertain',error:unknownMessage};
  const result = value as { request_id?: unknown; state?: unknown; error?: unknown; message?: unknown };
  if (result.request_id !== intent.request_id) return {state:'uncertain',error:unknownMessage};
  const error = typeof result.error === 'string' ? result.error : unknownMessage;
  if (result.state === 'sent') {
    const message = result.message as SentMessage | null;
    if (message?.id && message.conversation_id === intent.conversation_id && message.channel_id === intent.channel_id) return {state:'sent',message};
    return {state:'uncertain',error:unknownMessage};
  }
  if (result.state === 'failed' || result.state === 'pending' || result.state === 'in_flight') return {state:result.state,error};
  return {state:'uncertain',error};
}
export function isUnresolvedOutbound(attempt: Pick<OutboundAttempt,'state'>): boolean {
  return attempt.state === 'pending' || attempt.state === 'in_flight' || attempt.state === 'uncertain';
}
export function hasUnresolvedDuplicate(attempts: OutboundAttempt[], intent: Omit<SendIntent,'request_id'>): boolean {
  return attempts.some(row => isUnresolvedOutbound(row) && row.conversation_id === intent.conversation_id && row.channel_id === intent.channel_id && row.text.trim() === intent.text.trim());
}
export function mergeOutboundAttempts(local: OutboundAttempt[], remote: OutboundAttempt[]): OutboundAttempt[] {
  const rows = new Map(local.map(row => [row.request_id,row]));
  for (const row of remote) {
    const previous=rows.get(row.request_id);
    // A stale poll must not regress an already terminal local confirmation.
    if (previous && !isUnresolvedOutbound(previous) && isUnresolvedOutbound(row)) continue;
    rows.set(row.request_id,row);
  }
  return [...rows.values()];
}

export type OutboundScope = {orgId: string; userId: string};
export type OutboundMarker = Pick<SendIntent,'request_id'|'conversation_id'|'channel_id'> & {created_at: string};
type DurableStorage = Pick<Storage,'length'|'key'|'getItem'|'setItem'|'removeItem'>;
function markerPrefix(scope: OutboundScope): string {
  if (!scope.orgId || !scope.userId) throw new Error('Identidade necessária para proteger o envio.');
  return `clinprime-outbound-v2:${encodeURIComponent(scope.orgId)}:${encodeURIComponent(scope.userId)}:`;
}
export function readOutboundMarkers(storage: DurableStorage, scope: OutboundScope): OutboundMarker[] {
  const prefix=markerPrefix(scope); const rows: OutboundMarker[]=[];
  for (let index=0;index<storage.length;index++) {
    const key=storage.key(index); if (!key?.startsWith(prefix)) continue;
    const raw=storage.getItem(key); if (!raw) continue;
    const row=JSON.parse(raw);
    if (!row || typeof row!=='object' || ['request_id','conversation_id','channel_id','created_at'].some(field=>typeof row[field]!=='string'||!row[field]) || key!==prefix+row.request_id) {
      throw new Error('Controle local de envio inválido. Consulte as tentativas antes de enviar.');
    }
    rows.push({request_id:row.request_id,conversation_id:row.conversation_id,channel_id:row.channel_id,created_at:row.created_at});
  }
  return rows;
}
export function persistOutboundMarker(storage: DurableStorage, scope: OutboundScope, intent: SendIntent): void {
  const key=markerPrefix(scope)+intent.request_id;
  // Independent keys prevent one tab's append/removal from overwriting another's marker.
  // Explicit whitelist: never persist patient names, phone numbers or message contents.
  const value=JSON.stringify({request_id:intent.request_id,conversation_id:intent.conversation_id,channel_id:intent.channel_id,created_at:new Date().toISOString()});
  storage.setItem(key,value);
  if (storage.getItem(key)!==value) throw new Error('Não foi possível proteger a identidade do envio neste navegador.');
}
export function removeOutboundMarker(storage: DurableStorage, scope: OutboundScope, requestId: string): void {
  storage.removeItem(markerPrefix(scope)+requestId);
}
export function hasUnknownOutboundMarker(markers: OutboundMarker[], attempts: OutboundAttempt[], conversationId: string): boolean {
  return markers.some(marker=>marker.conversation_id===conversationId && !attempts.some(attempt=>attempt.request_id===marker.request_id && (!isUnresolvedOutbound(attempt) || !!attempt.text)));
}
