# CRM ClinPrime: entrega da base operacional

## Resultado desta etapa
Esta branch implementa a fundação do CRM, sem configurar agentes nem modificar produção.

1. **Caixas por setor e número:** Recepção, Comercial e CRC, com classificação explícita de cada canal na tela Conexões. Um paciente mantém um cadastro único, com conversas distintas por número.
2. **Envio determinístico:** cada envio informa a conversa e o canal. Canal incompatível ou desligado bloqueia o envio. Não existe fallback para o último número usado ou primeiro canal disponível.
3. **Pendências duráveis:** página Pendências e painel dentro da conversa. Responsável, prazo e status são obrigatórios. Mensagens não encerram a pendência. Resolver exige evidência, registra usuário e horário, e preserva o registro resolvido.
4. **Proteção no banco:** vínculos entre organização, paciente, conversa e responsável; RLS nas tabelas novas; identidade de conversa imutável; criação de paciente por WhatsApp serializada por telefone; eventos repetidos não duplicam mensagens e eventos antigos não recuam a atividade recente.

O controle antigo de IA por paciente foi retirado do Inbox: ele não distinguia os números e poderia alterar outro atendimento. Nenhuma nova supervisão, credencial ou integração de agente foi adicionada.

## Verificações
- npm test: **23/23 passaram**, incluindo testes unitários, PostgreSQL sintético e execução das funções de envio/webhook com transporte falso.
- npm run typecheck: **passou**.
- npm run build: **passou**, build Next.js usando URL/chave fictícias de Supabase, sem consultar produção.
- ESLint nos arquivos alterados: **passou**, sem erros ou avisos.
- O lint global já tinha problemas. Permanecem sete erros fora deste trabalho: efeitos em Metas e Pacientes, require em legacy/server-static.js e any nos helpers WA/onboarding. Não são um passe global de lint.
- O teste de navegador está preparado em tests/browser, mas não foi executado até o final: o Chromium deste ambiente não consegue criar um socket local; o navegador separado não alcança o servidor local do workspace. Layout, navegação e persistência visual ainda precisam de QA em ambiente de teste.

## Antes de aplicar a migração em staging
O repositório não versiona o esquema completo do banco atual. Os testes usam um predecessor mínimo e sintético, não uma cópia de produção. Portanto, não basta executar as migrações deste repositório num banco vazio.

1. Obter uma cópia de esquema sanitizada do ambiente atual, sem dados pessoais, e revisar as policies/triggers/views existentes. A migração espera organizations, org_members, channels, crm_patients, crm_messages, crm_pipeline_stages, crm_deals e phone_canon.
2. Verificar duplicatas em (org_id,user_id) e vínculos antigos entre organizações. Dados inconsistentes bloqueiam a transação, em vez de serem reatribuídos silenciosamente.
3. Testar a migração 20261103030000_crm_foundation.sql e restore/rollback no staging. A migração é transacional e deve ser aplicada uma vez pelo controle de migrações.
4. Confirmar RLS e permissões das tabelas preexistentes e a publicação Supabase Realtime para crm_messages/crm_conversations. Sem publicação, o refresh manual funciona, mas atualizações ao vivo não foram garantidas.
5. Classificar explicitamente os números existentes nos três setores. A migração não adivinha setores nem muda números/provedores.
6. Atualizar juntas a UI, a função de envio e a migração. O contrato antigo patient_id/text deixa de ser aceito. Revisar qualquer consumidor externo dessa função antes de publicar.
7. Testar com dois usuários de organizações distintas e números exclusivamente de teste: mesmo paciente em dois canais; troca de conversa durante envio; número desligado; evento repetido; pendência sem descrição; recarga sem nova mensagem; evidência e autoria da resolução.

## Limites conhecidos e próximas fases
- Mensagens antigas sem channel_id não são atribuídas automaticamente. Elas continuam no banco; devem receber uma estratégia explícita de histórico antes da troca operacional do Inbox.
- A função atual de envio é da API oficial Meta. Canais Evolution/Instagram não recebem fallback por outro número. A integração correspondente precisa ser validada em etapa própria.
- Mensagens fora da janela de 24 horas continuam dependendo de template aprovado; esta entrega não cria templates nem envia mensagens reais.
- Em falha de gravação após aceitação do WhatsApp, o erro informa para conferir antes de reenviar. Uma caixa de saída transacional/idempotente é uma evolução recomendada antes de escala.
- Ainda não houve teste do esquema real, entrega WhatsApp real, migração aplicada ou deploy. A branch é para revisão e validação em staging, não uma afirmação de prontidão de produção.

## Ordem sugerida
1. Revisar e integrar esta fundação.
2. Reproduzir o esquema em staging e completar os testes de UI/segurança/integração.
3. Validar com a equipe recepção/comercial/CRC usando apenas dados e números de teste.
4. Planejar a entrada em operação separadamente, com autorização e checklist de backup.
5. Só depois definir a integração/supervisão dos agentes.

## Correções encontradas na revisão
Descrição opcional vazia agora é compatível com a coluna NOT NULL; mensagens antigas sem canal também validam a organização do paciente; novas URLs de conversa substituem a seleção anterior; o RPC rejeita evidência composta somente de espaços, tabs ou quebras de linha. Quatro novos testes reproduziram os defeitos antes das correções e passaram depois delas.
