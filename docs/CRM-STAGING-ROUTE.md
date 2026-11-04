# Rota concreta para staging do CRM

## O que já existe

- Branch de revisão `codex/crm-channel-pending-foundation`, PR em rascunho1.
- Prévia privada com a interface completa e dados fictícios. É revisão de UX, não um Supabase operacional.
- Migrações reais300→700, testes SQL/HTTP com dados sintéticos e pré-auditoria somente leitura em `docs/schema/crm-preflight.sql`.
- Correção do vínculo da sessão: `getMyOrg` verifica o usuário autenticado e seleciona apenas sua associação. Listar colegas não pode determinar o papel da sessão.

## Disponibilidade verificada em 4 de novembro de 2026 (UTC)

Não há ambiente de CRM registrado ou computador conectado no catálogo disponível; existe apenas o ambiente `labgest`, referente a outro projeto. O conector Supabase foi conectado durante esta etapa e o projeto do CRM foi identificado. A autorização atual cobre apenas inspeção estrutural de catálogo, sem registros de pacientes, contagens de dados ou mudanças. A consulta de metadados, sem descriptografia, das variáveis do projeto Vercel `crmclinprime` foi recusada com403. Nenhuma tentativa foi feita de contornar a restrição ou ler valores por outra rota.

O repositório não tem `supabase/config.toml` nem o predecessor completo. `server/migrations/001_initial_schema.sql` pertence ao servidor legado e não substitui as tabelas/views/funções do app Supabase. O arquivo de ambiente de produção rastreado no Git não é um destino de staging e não foi usado para conectar.

## Próxima entrada necessária

A conexão já permite iniciar a revisão de catálogo/esquema, sem ler registros de pacientes nem executar mutações. Ela não autoriza automaticamente criar projetos, alterar permissões, migrar ou publicar. Ainda é necessário um **destino de testes separado autorizado** e um predecessor sanitizado fiel ao catálogo observado. Quando a leitura de metadados não for suficiente, o responsável pelo ambiente pode fornecer uma exportação de esquema sanitizada. Não enviar senhas ou chaves pelo chat. Para a análise inicial basta um arquivo de esquema, sem nenhuma linha de dados, contendo:

1. Definições das tabelas/views usadas pelo app: organizações, membros, pacientes, mensagens, canais, funil e suas views/aliases legadas. Ver a lista exata da pré-auditoria.
2. Constraints, índices, defaults, triggers, funções, RLS/policies e permissões relevantes. O papel `admin` deve ter significado conhecido em `org_members`.
3. Definições de publicação Realtime e histórico de migrações aplicado.
4. Contrato sanitizado do consumidor antigo de IA somente se for necessário preservar pausa/retomada; não fornecer credenciais ou configurar um novo agente.

Antes de compartilhar, revisar corpos de funções, comentários e defaults: um dump somente de esquema ainda pode conter tokens, URLs privadas ou dados literais. Não incluir valores de `channel_secrets`, pacientes, mensagens, logs, arquivos de ambiente, senhas, chaves ou tokens. O esquema sanitizado não deve ser anexado a um PR público indiscriminadamente.

## Sequência após obter as entradas

1. Revisar o esquema sanitizado e reconciliar a lista de migrações com o estado de origem. Não aplicar um predecessor inventado para “fazer passar”.
2. Preparar um banco de testes novo e isolado. Carregar somente esse esquema e identidades inteiramente fictícias de duas organizações. Não restaurar registros de pacientes reais.
3. Executar a pré-auditoria completa em transação somente leitura. Bloqueio de leitura, incompatibilidade de tipo ou consulta incompleta não vale como aprovação.
4. Aplicar migrações300→700 na sequência controlada e repetir a auditoria. Conferir grants, políticas, resolução manual, outbox e auditoria.
5. Validar autenticação JWT real e assinaturas Realtime: A recebe apenas A; B e sessão anônima nunca recebem A; testar reconexão e retirada de associação. PostgreSQL local não comprova isso.
6. Separadamente, quando autorizado, ligar somente um número de teste à configuração de staging e validar webhook, janela24h, catálogo aprovado, timeout, aceite e reconciliação. Nunca reutilizar as credenciais ou o número operacional para facilitar o teste.
7. Validar backup/restore e preparação conjunta de UI, funções e banco. Merge e produção continuam sendo uma decisão posterior, fora da autorização desta etapa.

## O que pode avançar sem essas entradas

Correções com contratos já demonstrados, testes sintéticos e ensaios de concorrência em PostgreSQL descartável. Nenhum resultado local prova compatibilidade com o esquema desconhecido, isolamento do backend da prévia automática Vercel, Realtime hospedado ou envio real pela Meta.
