// Pure fail-closed route validation shared by the send endpoint and offline tests.
type Conversation = { id: string; org_id: string; patient_id: string; channel_id: string };
type Channel = { id: string; org_id: string; type: string; status: string; phone_number_id: string | null; inbox_key?: string | null };
export function validateSendRoute(input: { conversation_id?: unknown; channel_id?: unknown }, conversation: Conversation | null, channel: Channel | null): string | null {
  if (typeof input.conversation_id !== 'string' || typeof input.channel_id !== 'string' || !input.conversation_id || !input.channel_id) return 'conversation_id e channel_id obrigatorios';
  if (!conversation || conversation.id !== input.conversation_id) return 'conversa nao encontrada';
  if (!channel || channel.id !== input.channel_id || conversation.channel_id !== channel.id || conversation.org_id !== channel.org_id) return 'canal incompativel com a conversa';
  if (!['reception','commercial','crc'].includes(channel.inbox_key ?? '')) return 'canal sem caixa de entrada definida';
  if (channel.type !== 'whatsapp_cloud' || channel.status !== 'connected' || !channel.phone_number_id) return 'canal desconectado ou indisponivel';
  return null;
}
