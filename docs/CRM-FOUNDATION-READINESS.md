# CRM ClinPrime: preparação operacional

## Implementado na branch de revisão

- Recepção, Comercial e CRC separados por número, com conversas por paciente/canal e resposta explícita, sem fallback.
- Pendências persistidas com responsável, prazo, status e resolução manual com evidência, autor e horário. Mensagens não as encerram.
- Histórico antigo sem canal acessível em `/historico-legado`, somente leitura e sem inferir o número. Busca por paciente, paginação estável e tratamento de página removida.
- Migração 400 restringe grants herdados, protege IDs de pendências e registra as tabelas CRM no Realtime existente, sem inventar policies antigas.
- Migração 500 cria ledger de envio e claim atômico por UUID. Timeout e falha após aceite não provocam repetição. Consulta de tentativa é somente leitura.
- Recuperação do cliente após recarga ou navegação preserva apenas os identificadores da tentativa, sem texto do paciente no armazenamento do browser. Layout do Inbox passa a empilhar painéis fora de telas largas.
- Auditoria SQL somente leitura de predecessores, vínculos, RLS, grants por tabela/coluna, RPCs e publicação: `docs/schema/crm-preflight.sql`.

Nenhuma nova supervisão, API, credencial ou integração de agente foi implementada. Não houve uso de pacientes reais, migração de números, aplicação em banco externo, merge ou publicação do CRM operacional.

## Verificações da etapa anterior (commit c914b3c)

**83/83 testes passaram** na verificação final local. Foram executados testes unitários, SQL real com predecessor sintético em PGlite, endpoint real com transporte falso e contratos HTTP do cliente Supabase. Typecheck e build Next.js com Supabase fictício foram executados. O lint dos arquivos alterados passou.

O lint global mantém sete erros preexistentes fora desta entrega: efeitos em Metas/Pacientes, CommonJS no servidor legado e tipos `any` de WA/onboarding. Não é um passe global.

A interface foi conferida em navegador usando apenas dados e adaptadores sintéticos: separação de setores, resposta atrasada sem aparecer na outra conversa, consulta de legado, pendência/resolução, resultado incerto persistente após recarga, bloqueio de texto repetido e recarga antes do registro do envio. O script Playwright atualizado em `tests/browser` não foi executado integralmente neste ambiente. Não houve teste em telefone físico, autenticação real, Realtime WebSocket, WhatsApp real ou banco hospedado.

## Antes de staging e produção

1. Obter esquema sanitizado do ambiente atual. O repositório não contém o predecessor completo; não basta executar as migrações em um banco vazio.
2. Rodar e revisar a pré-auditoria em uma cópia autorizada. Contagem bloqueada ou tipo incompatível não é aprovação. Conferir policies/grants antigos e dois tenants.
3. Aplicar e testar as migrações 300 → 400 → 500 → 600 → 700 em staging, com backup/restore. A 400 exige publicação Supabase Realtime existente e RLS de mensagens ativa; não presume que as policies sejam corretas.
4. Validar Realtime com JWTs sintéticos, isolamento entre organizações, reconexão e remoção de usuários. Os testes locais de publicação são somente de catálogo.
5. Classificar explicitamente os números em setores e validar somente números de teste. Evolution/Instagram continuam sem transporte substituto ou fallback; a função implementada usa a API oficial Meta. Templates de texto aprovados e janela de 24h estão implementados na nova etapa, mas ainda exigem configuração e validação em staging. Templates com mídia, botões, autenticação ou parâmetros nomeados não são suportados.
6. Implantar UI, funções e migrações em conjunto quando autorizado. Consumidores antigos `patient_id/text` são incompatíveis; novos clientes precisam `request_id/conversation_id/channel_id/text`.
7. Validar a conferência auditada por administrador antes de produção. O estado conservador pode bloquear uma conversa quando só existe marcador local e o resultado ainda não foi localizado. Não limpar cache nem criar novo UUID para contornar a incerteza. Ver `CRM-OUTBOUND-SAFETY.md`.
8. Validar concorrência real de múltiplas conexões/workers e os fluxos completos com a equipe. PGlite e mocks não comprovam infraestrutura distribuída.

## Revisão independente

Defeitos reproduzidos e corrigidos incluem grants `TRUNCATE` herdados apesar de RLS, ID de pendência mutável, perda de evidência de aceite tardio, perda de UUID após recarga/cache de navegação, sobrescrita de marcador por outra aba, página histórica HTTP 416 e lacunas no inventário de permissões da outbox. Regressões acompanham as correções.

## Nova etapa: conferência, templates e continuidade da interface

- Migração600: cancelar somente antes do claim, registrar observações sem inventar entrega, finalizar apenas aceite durável; evidência, ator e horário imutáveis.
- Migração700: texto livre apenas nas 24 horas da última mensagem recebida na mesma conversa/canal. Uma rejeição da janela é gravada como terminal para o UUID, sem despacho. Templates de texto aprovados são verificados na WABA do número, com prévia exata e variáveis vinculadas à intenção.
- O CRM continua usando sua interface original. A prévia sintética anterior mostrava só as áreas novas; a nova prévia restaura navegação e páginas existentes, mantendo integrações desativadas.
- Abertura de conversa por paciente e número explícitos, inclusive para paciente sem histórico; a ação não envia mensagem.
- Funil: falhas de gravação não mostram sucesso e a mudança otimista é desfeita sem sobrescrever alterações mais novas.

**159/159 testes passaram** no comando completo final, com execução serial dos arquivos para evitar pressão de memória causada por múltiplos PGlites. Typecheck, lint de todos os arquivos alterados, build Next.js com Supabase fictício e `git diff --check` passaram. O lint global continua com os mesmos sete erros preexistentes descritos acima.

A revisão independente identificou e foram corrigidos: observação auditada salva mas apresentada como erro HTTP; resposta atrasada sobrescrevendo cancelamento terminal; menu móvel acima do modal. Regressões cobrem as correções.

CUA verificou observação com evidência mantendo incerteza, cancelamento de tentativa não iniciada, registro de aceite persistido e template com prévia/variável explícita, usando somente adaptador estático sintético. A prévia completa teve as 13 páginas e a navegação em 390px verificadas; o modal móvel foi rechecado após corrigir a sobreposição do menu. A prévia estática tem 11 testes próprios, build e typecheck aprovados.

Os 27 contratos HTTP em `tests/browser/fixture-contract.test.mjs` usam o cliente Supabase real contra fronteira falsa. O runner Playwright completo e as novas sequências de navegador não foram executados. CUA com adaptador estático não comprova o conjunto HTTP + navegador + banco, Realtime, JWT real ou WhatsApp. Nenhum telefone físico, banco hospedado, provedor autenticado ou paciente real foi usado.

O antigo controle de IA por prefixo de telefone não foi restaurado: não há contrato/esquema do consumidor suficiente para comprovar a pausa por canal. Ver `CRM-AI-COMPATIBILITY.md`. É um bloqueio explícito para preservar esse recurso com segurança antes de produção, não uma afirmação de que a IA foi pausada.

## Sessão e concorrência PostgreSQL

A seleção da organização agora valida a sessão com `auth.getUser()`, filtra a associação pelo usuário e ordena por organização antes do limite. Ela não usa mais o papel ou nome da primeira associação visível de um colega. O dashboard não consulta métricas quando não há vínculo válido. Oito testes cobrem o cliente Supabase real com fronteira HTTP sintética, incluindo401.

`npm run test:postgres` usa conexões PostgreSQL independentes contra um cluster descartável. A verificação final local em PostgreSQL16.15 passou11/11 checks: barreiras observam o PID bloqueador e o lock real antes de liberar o commit. Cobrem claim repetido, as duas ordens claim/cancelamento, conclusão do worker, reconciliação e primeiro contato. Cópias temporárias dos SQLs sem locks falharam nos cenários correspondentes. Nenhum SQL de migração foi alterado por esses ensaios.

A revisão independente encontrou e corrigiu herança de `PGOPTIONS` apesar de uma string vazia no cliente. O teste agora instancia o `pg.Client` real com variáveis hostis fictícias. Guardas exigem loopback, identidade descartável, opt-in e catálogo vazio antes de DDL. Isso evita alvo acidental, mas não autoriza usar túneis ou bancos compartilhados.

O novo CI roda testes sintéticos, PostgreSQL16, typecheck e build, sem segredos/deploy. Remove arquivos de ambiente apenas do checkout descartável e fornece configuração falsa. A execução hospedada será registrada após publicação; um teste local não equivale a execução do Docker/GitHub.

A conexão Supabase tornou possível iniciar inspeção de catálogo do projeto existente. Isso não concede permissão para ler registros, executar contagens sobre pacientes, aplicar migrações ou testar provedores reais. Ver `CRM-STAGING-ROUTE.md`.

Verificação final desta etapa: **170/170 testes do comando completo passaram**, além dos **11/11 checks PostgreSQL** executados em cluster novo. Typecheck, build com Supabase fictício, lint dos arquivos alterados e diff-check passaram. Os três checks de guarda também fazem parte do comando normal; não somar as contagens como testes distintos.
