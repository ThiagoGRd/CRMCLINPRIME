// One durable request_id represents one user send intent. Only the worker that
// wins its atomic database claim may call WhatsApp. No automatic send retries.
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { localToWa } from '../_shared/wa.ts';
import { validateSendRoute } from '../_shared/routing.ts';
import { outboundResponse, readProviderOutcome, type OutboundResult } from '../_shared/outbound.ts';
import { normalizeTemplateIntent, prepareTemplateSend, PolicyError } from '../_shared/whatsapp-policy.ts';
import { loadTextTemplateCatalog } from '../_shared/whatsapp-catalog.ts';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
}
function resultResponse(result: OutboundResult, replayed: boolean) {
  const response = outboundResponse(result, replayed);
  return json(response.body, response.status);
}
const GRAPH = 'https://graph.facebook.com/v25.0';
const TOKEN = Deno.env.get('WA_ACCESS_TOKEN') ?? '';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);
  try {
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const authorization = req.headers.get('Authorization') ?? '';
    const jwt = /^Bearer\s+(\S+)$/i.exec(authorization)?.[1];
    if (!jwt) return json({ error: 'não autenticado' }, 401);
    const { data: { user }, error: authError } = await admin.auth.getUser(jwt);
    if (authError || !user) return json({ error: 'não autenticado' }, 401);

    let input;
    try { input = await req.json(); } catch { return json({ error: 'JSON inválido' }, 400); }
    if (!input || typeof input !== 'object' || Array.isArray(input)) return json({ error: 'requisição inválida' }, 400);
    const { request_id, conversation_id, channel_id, text, action } = input;
    if (typeof request_id !== 'string' || !UUID.test(request_id)) return json({ error: 'request_id UUID obrigatório' }, 400);
    if (action === 'status') {
      // Status lookup is read-only. Even an absent request must never become a send.
      const { data, error } = await admin.rpc('get_crm_outbound_request', { p_request_id: request_id, p_user_id: user.id });
      if (error || !data) return json({ request_id, error: 'Não foi possível consultar esta tentativa.', retryable: false }, 503);
      return resultResponse(data, true);
    }
    if (action === 'reconcile') {
      const { operation, evidence } = input;
      if (typeof conversation_id !== 'string' || !UUID.test(conversation_id) ||
          !['finalize', 'cancel', 'observe'].includes(operation) ||
          typeof evidence !== 'string' || !evidence.trim() || evidence.length > 2000) {
        return json({ error: 'Conversa, operação e evidência de até 2000 caracteres obrigatórias.' }, 400);
      }
      // Identity comes from verified authentication, never from request actor/role fields.
      // Recovery has no dependency on provider credentials, channel status or transport.
      const { data, error } = await admin.rpc('reconcile_crm_outbound_request', {
        p_request_id: request_id, p_user_id: user.id, p_conversation_id: conversation_id,
        p_operation: operation, p_evidence: evidence.trim(),
      });
      if (error || !data) {
        const code = error?.message ?? '';
        if (code.includes('outbound_access_denied')) return json({ error: 'Apenas administradores desta organização podem registrar a conferência.' }, 403);
        if (code.includes('outbound_request_not_found')) return json({ request_id, error: 'Tentativa não encontrada para esta operação.', retryable: false }, 404);
        if (code.includes('outbound_cancel_unsafe')) return json({ request_id, error: 'O envio já foi iniciado. Não é seguro cancelar ou criar outra tentativa sem conferir o resultado.', retryable: false }, 409);
        if (code.includes('outbound_acceptance_required')) return json({ request_id, error: 'Não há confirmação durável do WhatsApp para registrar esta mensagem.', retryable: false }, 409);
        if (code.includes('outbound_request_conflict') || code.includes('outbound_observation_unavailable')) return json({ request_id, error: 'Esta operação não corresponde ao estado ou à conversa da tentativa.', retryable: false }, 409);
        if (code.includes('outbound_evidence_required') || code.includes('outbound_input_invalid')) return json({ request_id, error: 'Operação ou evidência inválida.', retryable: false }, 400);
        return json({ request_id, error: 'Não foi possível confirmar a conferência. Consulte esta tentativa antes de continuar.', retryable: false }, 503);
      }
      // Successful audit is HTTP success even if delivery remains uncertain.
      return json(outboundResponse(data, true).body, 200);
    }
    if (action !== undefined) return json({ error: 'ação inválida' }, 400);
    const kind = input.kind ?? 'text';
    if (!['text', 'template'].includes(kind) || (kind === 'text' && input.template !== undefined) ||
        (kind === 'template' && text !== undefined)) return json({ request_id, error: 'Tipo de mensagem inválido.', retryable: false }, 400);
    let templateIntent: ReturnType<typeof normalizeTemplateIntent> | null = null;
    if (kind === 'template') {
      try { templateIntent = normalizeTemplateIntent(input.template); }
      catch (error) { return json({ request_id, code: error instanceof PolicyError ? error.code : 'template_input_invalid', error: 'Template ou variáveis inválidos.', retryable: false }, 400); }
    }
    let body = kind === 'text' ? (typeof text === 'string' ? text.trim() : '') : templateIntent!.preview;
    if (typeof conversation_id !== 'string' || !UUID.test(conversation_id) ||
        typeof channel_id !== 'string' || !UUID.test(channel_id) || !body) {
      return json({ error: 'conversation_id, channel_id e texto obrigatórios' }, 400);
    }
    if (body.length > 4096) return json({ error: 'mensagem acima de 4096 caracteres' }, 400);

    const { data: conversation, error: conversationError } = await admin.from('crm_conversations')
      .select('id,org_id,patient_id,channel_id').eq('id', conversation_id).maybeSingle();
    if (conversationError || !conversation) return json({ error: 'conversa não encontrada' }, 404);
    const { data: member, error: memberError } = await admin.from('org_members').select('org_id')
      .eq('user_id', user.id).eq('org_id', conversation.org_id).maybeSingle();
    if (memberError || !member) return json({ error: 'sem acesso' }, 403);
    const { data: channel, error: channelError } = await admin.from('channels').select('id,org_id,type,status,phone_number_id,inbox_key,waba_id')
      .eq('id', channel_id).eq('org_id', conversation.org_id).maybeSingle();
    const routeError = validateSendRoute({ conversation_id, channel_id }, conversation, channel);
    if (channelError || routeError || !channel) return json({ error: routeError ?? 'canal indisponível' }, 409);
    const { data: patient, error: patientError } = await admin.from('crm_patients').select('id,org_id,phone')
      .eq('id', conversation.patient_id).eq('org_id', conversation.org_id).maybeSingle();
    if (patientError || !patient?.phone) return json({ error: 'paciente sem telefone' }, 404);
    const { data: secret, error: secretError } = await admin.from('channel_secrets').select('access_token').eq('channel_id', channel.id).maybeSingle();
    if (secretError) return json({ error: 'Não foi possível verificar o acesso ao canal.' }, 503);
    const token = secret?.access_token ?? TOKEN;
    if (!token) return json({ error: 'número sem token de acesso' }, 503);

    let preparedTemplate: ReturnType<typeof prepareTemplateSend> | null = null;
    if (templateIntent) {
      try {
        const catalog = await loadTextTemplateCatalog({ graph: GRAPH, token, wabaId: channel.waba_id, phoneNumberId: channel.phone_number_id });
        preparedTemplate = prepareTemplateSend(catalog, templateIntent);
        body = preparedTemplate.content;
      } catch (error) {
        const unavailable = !(error instanceof PolicyError) || error.code === 'template_catalog_unavailable';
        return json({ request_id, code: error instanceof PolicyError ? error.code : 'template_catalog_unavailable',
          error: error instanceof PolicyError ? error.message : 'Não foi possível verificar os templates deste canal.', retryable: false }, unavailable ? 503 : 409);
      }
    }

    const { data: claim, error: claimError } = await admin.rpc('claim_crm_outbound_request', {
      p_request_id: request_id, p_user_id: user.id, p_conversation_id: conversation_id, p_channel_id: channel_id, p_content: body,
      p_message_kind: kind, p_template_payload: preparedTemplate?.templatePayload ?? null,
    });
    if (claimError) {
      const code = claimError.message;
      if (code?.includes('outbound_window_closed')) return json({ request_id, code: 'outside_service_window', error: 'Mais de 24h sem mensagem do paciente neste canal: use um template aprovado.', retryable: false }, 422);
      if (code?.includes('outbound_request_conflict')) return json({ request_id, error: 'Esta tentativa já pertence a outra mensagem, conversa ou usuário.', retryable: false }, 409);
      if (code?.includes('outbound_access_denied')) return json({ error: 'sem acesso' }, 403);
      if (code?.includes('outbound_route_unavailable')) return json({ error: 'canal indisponível' }, 409);
      // A lost claim response may have committed. Do not call the provider.
      return json({ request_id, state: 'pending', error: 'Não foi possível confirmar o início do envio. Consulte esta tentativa.', retryable: false }, 503);
    }
    if (!claim?.claimed || !claim.claim_token) {
      if (!claim?.state) return json({ request_id, error: 'Não foi possível confirmar esta tentativa.', retryable: false }, 503);
      return resultResponse(claim, true);
    }
    const finish = async (state: 'failed' | 'uncertain', failureCode: string, providerId: string | null = null) => {
      try {
        const { data, error } = await admin.rpc('finish_crm_outbound_request', {
          p_request_id: request_id, p_claim_token: claim.claim_token, p_state: state,
          p_failure_code: failureCode, p_provider_message_id: providerId,
        });
        if (!error && data) return resultResponse(data, false);
      } catch { /* The original claim still prevents any second dispatch. */ }
      return resultResponse({ request_id, state: 'uncertain', failure_code: failureCode, provider_message_id: providerId }, false);
    };
    let outcome;
    try {
      const response = await fetch(`${GRAPH}/${channel.phone_number_id}/messages`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', to: localToWa(patient.phone),
          ...(preparedTemplate ? { type: 'template', template: preparedTemplate.providerTemplate } : { type: 'text', text: { body } }) }),
      });
      outcome = await readProviderOutcome(response);
    } catch {
      return await finish('uncertain', 'transport_unknown');
    }
    if (outcome.state !== 'accepted') return await finish(outcome.state, outcome.failure_code);
    try {
      const { data, error } = await admin.rpc('complete_crm_outbound_request', {
        p_request_id: request_id, p_claim_token: claim.claim_token, p_provider_message_id: outcome.provider_message_id,
      });
      if (!error && data?.state === 'sent' && data.message) return resultResponse(data, false);
    } catch { /* Accepted send: do not dispatch again if the local commit is unknown. */ }
    return await finish('uncertain', 'storage_failed', outcome.provider_message_id);
  } catch {
    return json({ error: 'Não foi possível processar esta tentativa. Consulte o resultado antes de reenviar.', retryable: false }, 500);
  }
});
