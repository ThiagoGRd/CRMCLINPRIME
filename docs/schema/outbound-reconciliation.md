# Conferência auditada de envios

A migração `20261103060000_crm_outbound_reconciliation.sql` adiciona recuperação local à outbox da migração 500. A migração 700 preserva essa proteção e acrescenta templates e janela de atendimento. Nenhuma migração envia mensagens ao WhatsApp.

## Contrato

O endpoint autenticado `whatsapp-send` aceita:

```json
{
  "action": "reconcile",
  "request_id": "UUID da tentativa original",
  "conversation_id": "UUID da conversa original",
  "operation": "finalize | cancel | observe",
  "evidence": "Evidência não vazia de até 2000 caracteres"
}
```

O ator vem exclusivamente do usuário autenticado. Apenas a associação `org_members.role = 'admin'` pode executar a operação. Esse é o papel privilegiado estabelecido na interface de configurações; não há concessão automática para valores de papel desconhecidos. A função `reconcile_crm_outbound_request(uuid,uuid,uuid,text,text)` é exclusiva de `service_role` e também verifica o papel e a organização.

- `finalize`: usa somente `provider_message_id` já persistido no pedido. Insere a mensagem local usando conteúdo, tipo, rota e remetente imutáveis. Mensagem, transição para `sent` e auditoria são uma única transação. Não consulta catálogo ou provedor, não marca entrega ao destinatário e não aceita ID fornecido pelo navegador.
- `cancel`: cancela apenas um UUID ausente ou um pedido `pending` nunca reivindicado. Cria uma entrada permanente em `crm_outbound_cancellations`. Uma chamada atrasada com o mesmo UUID recebe `cancelled` e nunca adquire a autorização para transmitir. A decisão e a reivindicação usam o mesmo advisory lock transacional, inclusive quando ainda não existe linha na outbox.
- `observe`: acrescenta evidência a uma tentativa `in_flight` ou `uncertain` conhecida. Não muda a certeza do resultado, não substitui IDs e não libera reenvio. Uma aceitação posterior comprovada ainda pode completar a tentativa original.

As respostas mantêm o envelope de envio (`request_id`, `state`, `retryable: false`, `provider_message_id` quando disponível) e acrescentam `reconciliation` com `id`, `operation`, ator, evidência, estados anterior/resultante, organização, conversa e data. Toda conferência confirmada retorna HTTP 200 com a auditoria, inclusive uma observação que mantém o estado `in_flight` ou `uncertain`. Sucesso da conferência não significa sucesso do envio. Falhas da operação continuam retornando 4xx/5xx sem confirmação de auditoria.

## Garantias e limites

Membros da mesma organização leem as tabelas de auditoria/cancelamento por RLS. Não recebem permissões de escrita, exclusão, truncamento nem execução dos RPCs de serviço. Triggers impedem alteração e exclusão das entradas históricas. Revogar associação não apaga registros anteriores. Tokens de reivindicação permanecem fora dos dados disponibilizados ao navegador.

Uma reivindicação existente, mesmo antiga e sem ID de provedor, nunca pode ser cancelada com segurança ou retomada automaticamente. Uma nota manual não basta para fabricar confirmação. Falha ao inserir auditoria reverte também o cancelamento ou a gravação da mensagem. Resposta perdida exige consulta pelo UUID original. Repetir uma finalização confirmada reapresenta a mesma mensagem; cada conferência registrada continua auditável.

Um conflito de ID do provedor com outra mensagem existente falha sem sobrescrever ou reassociar essa mensagem. Esse caso ainda requer investigação, não uma fusão automática com um possível eco de webhook.

As validações locais usam somente SQL real em PGlite, dados sintéticos e transporte simulado. Exercitam as duas ordens serializadas de cancelamento/reivindicação, mas não substituem teste de sessões concorrentes no PostgreSQL de staging, JWT do Supabase, esquema predecessor real, políticas herdadas, backup/restore e revisão humana antes de implantação. Nenhum banco externo, credencial real, mensagem real, merge ou deploy foi utilizado.
