# Revisão de esquema e segurança em staging

## Entrega e limites

A migração `20261103040000_crm_security_realtime.sql` complementa a fundação, sem alterar a migração 300:

- Revoga permissões implícitas de `PUBLIC`, `anon` e `authenticated` nas duas tabelas novas. Devolve apenas `SELECT`, `INSERT` e `UPDATE` a `authenticated`; mantém a RLS por organização. Isso remove inclusive `TRUNCATE`, que não é protegido por políticas de linha.
- Mantém as permissões de ingestão do `service_role`, mas não concede resolução humana a esse papel. Resolução continua exigindo o RPC, usuário autenticado, associação à organização e evidência.
- Impede alteração da chave primária de uma pendência, além da identidade já protegida pela migração 300.
- Registra somente `crm_conversations`, `crm_messages` e `crm_pending_items` na publicação já existente `supabase_realtime`. Reexecutar a migração 400 não duplica associações. Outros membros e configurações existentes permanecem intactos.

A migração falha e reverte a transação se a publicação não existir ou se `crm_messages` estiver sem RLS. Ela não cria uma publicação abrangente, não inventa políticas para tabelas antigas e não corrige dados legados automaticamente. RLS habilitada é um requisito mínimo, não prova de que as políticas existentes são seguras.

Nenhum banco externo, dado real, credencial de produção, número WhatsApp, deploy ou aplicação de migração foi usado nesta implementação.

## Pré-auditoria somente leitura

`crm-preflight.sql` é um script SQL PostgreSQL 15+ para revisão humana. Usa transação `REPEATABLE READ READ ONLY`, termina com `ROLLBACK`, não cria objetos e não altera linhas. Rode o arquivo completo, em uma sessão nova, exclusivamente na cópia sanitizada de staging autorizada. Não execute trechos separadamente, pois perderiam as proteções da transação.

Exemplo para o responsável pelo staging, depois de preparar a conexão autorizada:

```sh
psql "$STAGING_DATABASE_URL" -X -v ON_ERROR_STOP=1 \
  -f docs/schema/crm-preflight.sql
```

O agente não executou esse comando contra um serviço. Os testes executam apenas a cópia local em memória do PGlite.

Preserve os **resultados das consultas e as mensagens NOTICE**. As mensagens com prefixo `CRM_PREFLIGHT` contêm JSON com `check_id`, `status` e `count`. Nenhum identificador de paciente, texto de mensagem, telefone ou credencial é selecionado pelos checks de dados. Os resultados de catálogo contêm definições reais do esquema, inclusive expressões de políticas/defaults; mantenha a cópia de esquema sanitizada e não publique essa saída indiscriminadamente.

O script verifica:

1. Colunas e tipos dos predecessores, incluindo `crm_messages.direction/content/message_type/status/sent_by`, funções `auth.uid()`/`phone_canon(text)`, papéis e heranças.
2. Duplicatas de associação `(org_id,user_id)`, membros sem identidade e referências a organizações inexistentes.
3. Pacientes/canais de mensagens fora da organização ou inexistentes; mensagens com canal, mas sem paciente; IDs WhatsApp repetidos; vínculos de negócios, conversas e pendências.
4. Mensagens antigas sem canal e canais sem classificação, como informação operacional, sem atribuição automática.
5. RLS, políticas existentes, permissões efetivas de tabela **e coluna** (inclusive `crm_outbound_requests.claim_token`), defaults, constraints, índices e triggers. Inclui a outbox e os grants das funções `claim`, `complete`, `finish` e `get_crm_outbound_request`.
6. Publicação Realtime, operações habilitadas, associação das três tabelas, listas de colunas e filtros de linha.

Use uma identidade de revisão autorizada que consiga ler as tabelas e consultar todas as linhas, por exemplo o proprietário da cópia sanitizada. O script configura `row_security=off`: isso **não concede bypass**. Se RLS impedir a consulta completa, o check retorna `blocked` em vez de um zero enganoso. As contagens podem exigir leitura integral; planeje capacidade em staging. Há limite de 60 segundos por instrução e 3 segundos de espera por lock. Timeout/cancelamento ou qualquer interrupção não é aprovação; reconecte e investigue antes de continuar.

### Como interpretar

- `missing` / `skipped_missing_columns`: pré-requisito ausente ou parte da fundação ainda não aplicada. Verifique a fase. Tabelas novas ausentes são esperadas antes da migração 300, e a outbox só existe após a 500; predecessores ausentes bloqueiam a aplicação.
- `review_type`: tipo diferente do esperado. Confirme compatibilidade com FKs, valores inseridos e funções. Não é um passe automático.
- `issues`: contagem positiva de inconsistência. Investigue na cópia sanitizada e defina uma correção explícita. Não reatribua registros entre organizações para fazer a migração passar.
- `blocked`: permissão, RLS ou outra falha impediu a contagem. `count` é nulo; `sqlstate` registra a classe de erro sem expor dados do erro.
- `info`: volume conhecido de legado sem canal ou classificação pendente. Requer estratégia operacional, não reparo automático.
- `clear`: somente aquele check encontrou zero problemas visíveis sob a leitura completa exigida. Não significa prontidão de produção.
- `enabled` / `member`: RLS está ativa / tabela pertence à publicação. Revise as políticas e opções. Uma publicação com `all_tables=true`, filtros de linha, lista restrita de colunas ou sem `INSERT`/`UPDATE` precisa de análise própria; a migração 400 preserva a configuração existente.

Não há um resultado global de “aprovado”: nenhuma soma de checks substitui a revisão do esquema predecessor real, dos papéis herdados, das políticas ou das integrações.

## Sequência de validação

1. Criar/restaurar uma cópia de esquema e dados inteiramente sintéticos/sanitizados. O repositório não contém o esquema inicial completo; não aplicar as migrações em um banco vazio como substituto.
2. Rodar a pré-auditoria e revisar predecessores, duplicatas, vínculos, grants e políticas. Garantir em particular que `crm_messages` tenha políticas corretas para dois tenants e nenhuma leitura pública indevida.
3. Aplicar a migração 300 apenas uma vez pelo controle normal de migrações. A migração 400 é reexecutável, mas isso não torna a 300 reexecutável. Aplicar 400 depois, seguida de 500 quando incluída na entrega. Uma publicação ausente exige preparar/configurar explicitamente o Realtime do ambiente; não remover o bloqueio da migração.
4. Repetir a auditoria. Confirmar que `anon` não tem acesso às tabelas novas e que `authenticated` não tem `DELETE`, `TRUNCATE` ou `TRIGGER`; revisar também heranças e grants de coluna do esquema real. `authenticated` não pode ler `claim_token` nem executar os RPCs de serviço da outbox; `anon` não pode ler a outbox. Uma permissão de coluna pode expor dados mesmo quando o grant de tabela parece restrito.
5. Testar com usuários exclusivamente sintéticos: membro da organização A, membro da B, autenticado sem associação, sessão sem usuário e `anon`. Validar SELECT/INSERT/UPDATE, IDs de outro tenant, atribuição, resolução e RPCs de serviço.
6. Testar assinaturas Realtime reais com esses usuários, mudanças de sessão e duas organizações. Uma atualização de conversa/pendência/mensagem de A deve chegar à sessão A autorizada e nunca à B/anon. Verificar reconexão, refresh e remoção da associação do usuário. Usar só números de teste se houver transporte WhatsApp.
7. Validar backup/restore, sequência de implantação conjunta e rollback em staging antes de propor produção. Não há rollback destrutivo automático: resolver grants ou publicações manualmente exige revisar o estado anterior preservado.

## O que os testes locais provam

`npm run test:db` executa os SQLs reais com o predecessor mínimo sintético e PGlite. Há reprodução e correção dos grants amplos e da mudança de ID, negativas de RLS/papéis, isolamento entre tenants, RPCs, preservação de resolução, idempotência da associação à publicação, bloqueios por pré-requisitos e execução conjunta das migrações 300/400/500. A auditoria é executada em esquema ausente, esquema inconsistente, esquema pós-migração e sessão limitada por RLS. Um teste aplica 300/400/500 e introduz propositalmente grant de leitura do token, grant de RPC para `authenticated`, RLS desabilitada na outbox e coluna de escrita ausente; a auditoria expõe cada alteração.

O PGlite oferece catálogos SQL de publicação, por isso é possível verificar `pg_publication_tables`. **Não valida replicação lógica de ponta a ponta**, WAL/slots/workers, transporte WebSocket, autenticação JWT do Supabase, autorização de assinaturas Realtime, latência, reconexão nem distribuição concorrente real. Os testes de papel usam `SET ROLE` e `auth.uid()` sintética. Não são testes de Supabase hospedado e não demonstram compatibilidade com o predecessor real desconhecido.

Referências primárias: [Supabase Postgres Changes](https://supabase.com/docs/guides/realtime/postgres-changes) e [PostgreSQL CREATE PUBLICATION](https://www.postgresql.org/docs/current/sql-createpublication.html). A primeira descreve a associação explícita à publicação; a segunda define publicações abrangentes, filtros, colunas e eventos. A existência no catálogo não prova a entrega de um evento.
