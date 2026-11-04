// Responses distinguish confirmed provider acceptance and saved CRM records from unknown outcomes.
// An uncertain or rejected request is never permission to dispatch it again.
export type OutboundResult = {
  request_id: string;
  state: 'pending' | 'in_flight' | 'sent' | 'failed' | 'uncertain' | 'cancelled' | 'not_found';
  failure_code?: string | null;
  provider_message_id?: string | null;
  message?: unknown;
  reconciliation?: { id: string; operation: string; [key: string]: unknown };
  claimed?: boolean;
  claim_token?: string | null;
};
export function outboundResponse(result: OutboundResult, replayed: boolean) {
  const base = { request_id: result.request_id, state: result.state, retryable: false, replayed, ...(result.provider_message_id !== undefined ? { provider_message_id: result.provider_message_id } : {}), ...(result.reconciliation ? { reconciliation: result.reconciliation } : {}) };
  if (result.state === 'sent' && result.message) return { status: 200, body: { ...base, message: result.message } };
  if (result.state === 'cancelled') return { status: 200, body: { ...base, info: 'Tentativa cancelada antes do envio. Este identificador não poderá enviar mensagens.' } };
  if (result.state === 'not_found') return { status: 404, body: { ...base, error: 'Tentativa não encontrada. Nenhuma mensagem foi enviada por esta consulta.' } };
  if (result.state === 'pending' || result.state === 'in_flight') return { status: 202, body: { ...base, error: 'Envio em processamento. Consulte esta tentativa antes de enviar novamente.' } };
  if (result.state === 'failed') {
    const outsideWindow = result.failure_code === 'outside_service_window' || result.failure_code === 'provider_rejected_131047';
    return { status: 422, body: { ...base, ...(outsideWindow ? { code: 'outside_service_window' } : {}),
      error: outsideWindow ? 'Mais de 24h sem mensagem do paciente neste canal: use um template aprovado.'
        : 'O WhatsApp recusou esta tentativa. Ela não será reenviada automaticamente.' } };
  }
  return { status: 409, body: { ...base, state: 'uncertain', delivery_accepted: Boolean(result.provider_message_id),
    error: result.provider_message_id
      ? 'Mensagem aceita pelo WhatsApp, mas o registro no CRM não foi confirmado. Confira antes de reenviar.'
      : 'Não foi possível confirmar o resultado do envio. Confira no WhatsApp antes de criar uma nova tentativa.' } };
}
export type ProviderOutcome =
  | { state: 'accepted'; provider_message_id: string }
  | { state: 'failed' | 'uncertain'; failure_code: string };
export async function readProviderOutcome(response: Response): Promise<ProviderOutcome> {
  let data;
  try { data = await response.json(); } catch { return { state: 'uncertain', failure_code: 'provider_response_invalid' }; }
  if (!response.ok) {
    // Only an explicit client-error rejection is definitive. Timeouts, 5xx,
    // proxy errors and unparseable responses may follow an accepted send.
    if (response.status >= 400 && response.status < 500 && response.status !== 408 &&
        typeof data?.error?.code === 'number') {
      return { state: 'failed', failure_code: `provider_rejected_${data.error.code}` };
    }
    return { state: 'uncertain', failure_code: 'provider_outcome_unknown' };
  }
  const providerId = data?.messages?.[0]?.id;
  if (typeof providerId !== 'string' || !providerId.trim()) return { state: 'uncertain', failure_code: 'provider_id_missing' };
  return { state: 'accepted', provider_message_id: providerId };
}
