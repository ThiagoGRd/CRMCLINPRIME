# Envio com identidade durável

## Contrato

`whatsapp-send` recebe `request_id` UUID, `conversation_id`, `channel_id` e `text`, ou `kind: template` com identidade, variáveis e prévia confirmada do template (ver `CRM-WHATSAPP-TEMPLATES.md`). O usuário autenticado precisa pertencer à organização da conversa. O canal precisa estar conectado, classificado em Recepção/Comercial/CRC e ser compatível com a API oficial. Não existe fallback para outro número.

Um UUID identifica **uma intenção de envio**, com organização, usuário, conversa, canal e conteúdo imutáveis. Um RPC de claim serializa essa identidade antes de qualquer chamada ao provedor. Somente o dono do token privado de claim pode registrar seu resultado. O navegador não pode ler esse token nem executar os RPCs de serviço.

- `sent`: provedor aceitou e mensagem/ledger foram salvos na mesma transação.
- `failed`: rejeição explícita pelo provedor ou bloqueio local durável da janela de atendimento, sem reenvio automático.
- `cancelled`: cancelamento auditado antes do envio; o UUID fica permanentemente impedido de enviar.
- `pending`/`in_flight`: nenhuma segunda chamada externa é permitida para esse UUID.
- `uncertain`: timeout, resposta inválida, falta de ID, falha de armazenamento ou resultado desconhecido. Não há recuperação automática do claim ou nova tentativa externa.

A garantia é **no máximo um despacho por UUID**, não entrega exatamente uma vez, deduplicação de intenções distintas ou confirmação de leitura pelo paciente. O sucesso da API Meta não é prova de entrega ao aparelho. Respostas tardias com o token original podem confirmar um envio ou preservar a evidência de aceite, sem novo despacho.

## Recuperação no Inbox

Antes da chamada, o browser grava uma chave independente por UUID, separada por organização e usuário. Só contém UUID da tentativa, IDs da conversa/canal e horário. Não guarda texto, nome ou telefone do paciente. Falha no armazenamento bloqueia o envio antes de chamar a função.

Ao recarregar, o Inbox consulta o ledger e faz chamadas `{"request_id":"...","action":"status"}`. Essa ação é somente leitura: não cria registros, não faz claim e não envia. A consulta antes de cada novo envio relê os marcadores e a sessão atual, mesmo quando o cache de navegação está recente. Chaves independentes impedem que outra aba apague o marcador de uma tentativa diferente.

Enquanto um envio conhecido estiver incerto, a mesma mensagem fica bloqueada. Quando só o marcador existe e seu texto ainda não foi recuperado do servidor, novos envios na conversa ficam bloqueados. A interface permite consultar novamente; não oferece um botão de reenvio que silenciosamente gere outro UUID.

## Limites para operação

Um marcador não encontrado pode significar que a chamada não chegou ao servidor, está atrasada ou perdeu acesso. **Não é prova de falha de entrega.** Esses casos permanecem bloqueados até a conferência auditada descrita abaixo. Um administrador pode cancelar apenas uma tentativa ausente ou ainda não iniciada. Uma tentativa já reivindicada continua incerta até evidência durável do provedor. Limpar armazenamento/cache ou criar outro UUID não deve ser usado como correção de um resultado desconhecido.

Uma intenção nova deliberada, outro dispositivo ou armazenamento limpo não compartilha automaticamente a identidade anterior. Não há deduplicação semântica de textos nem garantia distribuída entre clientes diferentes. Confirmar concorrência real com múltiplas conexões PostgreSQL/Edge Functions em staging continua necessário.

## Verificação

Os testes executam o SQL e o endpoint reais em PGlite, com fronteira HTTP/WhatsApp falsa: concorrência/repetição, vinculação imutável, auth/tenant, status sem despacho, timeout, 5xx, resposta inválida, rejeição explícita, falha após aceite, resposta de commit perdida e aceite tardio após claim envelhecido. O cliente tem regressões para navegação, armazenamento indisponível, isolamento por usuário/organização e escritas intercaladas entre abas.

O navegador foi exercitado apenas com adaptadores e dados sintéticos. Não foram usados credenciais, pacientes ou números reais. Esses testes não certificam o esquema predecessor, a infraestrutura de execução, a disponibilidade dos provedores ou a entrega real.

## Conferência auditada por administrador

A migração600 introduz `crm_outbound_reconciliations`, histórico somente anexável com operação, evidência, ator autenticado, conversa, estado anterior/posterior e horário. Membros podem consultar; somente o endpoint de serviço autenticado executa o RPC e este exige `org_members.role = admin`. Não existe ator informado pelo cliente.

O painel oferece três operações explícitas:
- **Registrar mensagem aceita:** usa exclusivamente `provider_message_id` já persistido no ledger e os dados imutáveis da tentativa. Salva a mensagem e a auditoria atomicamente, sem chamar Meta. Não é uma declaração de entrega ou leitura pelo paciente.
- **Cancelar tentativa não iniciada:** cria um tombstone permanente e auditado, com o mesmo bloqueio transacional usado pelo claim. Uma chamada original atrasada não pode despachar esse UUID. Não cancela chamadas já reivindicadas, incertas ou aceitas.
- **Registrar observação:** guarda o que o operador conferiu e mantém a incerteza. Texto humano não se transforma em confirmação de entrega.

Falha ao gravar a auditoria reverte a operação inteira. Uma resposta de conferência perdida exige consulta de estado/histórico; não implica novo envio. Novas tentativas não são criadas por nenhuma dessas ações. O estado `uncertain` sem prova durável de aceite continua uma limitação operacional deliberada: não há exclusão forçada ou liberação silenciosa de reenvio.
