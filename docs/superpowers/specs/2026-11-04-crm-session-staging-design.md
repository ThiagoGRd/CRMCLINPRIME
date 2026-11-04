# Sessão autenticada e preparação de staging

O pedido continua sendo tornar o CRM existente funcional, preservando a interface e sem usar produção. Esta etapa fecha dois pontos demonstráveis com dados sintéticos: a seleção do vínculo correto do usuário e o comportamento concorrente das transações PostgreSQL.

## Decisões de implementação

- Corrigir `getMyOrg` para obter o usuário validado via `auth.getUser()`, filtrar `org_members.user_id` e ordenar `org_id` antes do limite existente. O papel/nome nunca devem vir da associação de um colega. Manter a escolha determinística de uma organização, sem introduzir um seletor multi-organização neste incremento.
- Falhar fechado se não houver usuário, vínculo legível ou organização relacionada válida. O dashboard precisa tratar essa ausência antes de consultar métricas.
- Não substituir RLS por filtros: filtros são defesa adicional; o esquema/policies reais continuam pendentes de staging.
- Acrescentar ensaio PostgreSQL descartável, com predecessor exclusivamente sintético e conexões independentes, e verificação de CI sem segredos. Não chamar esse ensaio de Supabase completo.

## Alternativas e limites

Confiar apenas na primeira associação visível preservaria o defeito. Introduzir uma nova modelagem real ou um seletor completo agora exigiria inventar contrato ausente. Por isso a correção mantém os contratos existentes e testa os limites conhecidos. Não acessa `.env.production`, dados de pacientes, provedores, credenciais, migrações externas ou configuração de agentes.

A consulta somente de metadados de ambiente no Vercel foi negada (403). O catálogo de ambientes contém apenas `labgest`, sem CRM, e nenhum computador conectado. Essa ausência não será contornada. A rota hospedada exige projeto de staging autorizado e esquema sanitizado real.
