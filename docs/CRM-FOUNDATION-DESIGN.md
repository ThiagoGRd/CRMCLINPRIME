# Base operacional do CRM ClinPrime

## Objetivo e limites
Preparar o CRM existente para trabalhar com três caixas, Recepção, Comercial e CRC, separadas pelo número conectado. Uma pessoa continua sendo um paciente, mas cada par paciente + canal tem sua própria conversa. As pendências devem existir no Supabase independentemente de novas mensagens e só ser encerradas por ação explícita com evidência.

A implementação usa a base existente Next.js, React e Supabase. Não envolve dados de produção, migração de números, deploy, supervisão de agentes, novas credenciais/API de agentes nem encerramento automático.

## Diagnóstico confirmado
O Inbox atual usa pacientes como conversas, lê o histórico por patient_id e envia sem indicar canal. A função de envio escolhe o último canal inbound do paciente ou o primeiro número disponível. Isso mistura históricos e pode responder por outro setor. O repositório tem poucas migrações incrementais e não contém o esquema completo de produção. Follow-up mostra orçamentos e cadências, mas não uma fila durável de pendências manuais.

## Decisões de implementação
- Adicionar inbox_key opcional aos canais com valores reception, commercial, crc. Nenhum número será automaticamente classificado.
- Criar crm_conversations única por org_id + patient_id + channel_id, com associação consistente no banco. Mensagens sem canal conhecido não serão atribuídas por adivinhação.
- Vincular mensagens à conversa no banco. Responder exige conversation_id e channel_id válidos; nunca escolher silenciosamente outro número.
- Adicionar crm_pending_items com paciente, conversa, responsável da organização, prazo obrigatório, status open/in_progress/resolved e evidência de resolução. A resolução registra usuário e horário.
- Mostrar pendências em página própria e no painel da conversa. Recarregar o aplicativo não pode apagá-las, nem mensagens recebidas ou enviadas podem encerrá-las.
- Manter dados legados sem canal identificados como não classificados, sem reatribuição automática.

## Alternativas consideradas
Filtrar somente crm_messages por canal é menor, mas não oferece identidade estável para atribuição e pendências. Criar pacientes duplicados por número quebraria o histórico clínico. A conversa explícita é a escolha técnica desta implementação, preservando o cadastro único de paciente.

## Critérios de aceite
1. O mesmo paciente em dois números produz duas conversas e duas listas de mensagens distintas.
2. Recepção, Comercial e CRC têm abas próprias e seleção de número explícita quando necessário.
3. Trocar de conversa durante envio não injeta a resposta nem o rascunho em outra conversa.
4. Canal ausente, desligado ou incompatível bloqueia envio em vez de usar fallback.
5. Pendência sobrevive sem mensagens, exige responsável e prazo, e exige evidência para resolver manualmente.
6. RLS e vínculos impedem referências entre organizações.
7. Testes usam somente fixtures sintéticas e não fazem chamadas externas de envio.
