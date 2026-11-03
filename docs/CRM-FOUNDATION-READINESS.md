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

## Verificações desta continuação

**83/83 testes passaram** na verificação final local. Foram executados testes unitários, SQL real com predecessor sintético em PGlite, endpoint real com transporte falso e contratos HTTP do cliente Supabase. Typecheck e build Next.js com Supabase fictício foram executados. O lint dos arquivos alterados passou.

O lint global mantém sete erros preexistentes fora desta entrega: efeitos em Metas/Pacientes, CommonJS no servidor legado e tipos `any` de WA/onboarding. Não é um passe global.

A interface foi conferida em navegador usando apenas dados e adaptadores sintéticos: separação de setores, resposta atrasada sem aparecer na outra conversa, consulta de legado, pendência/resolução, resultado incerto persistente após recarga, bloqueio de texto repetido e recarga antes do registro do envio. O script Playwright atualizado em `tests/browser` não foi executado integralmente neste ambiente. Não houve teste em telefone físico, autenticação real, Realtime WebSocket, WhatsApp real ou banco hospedado.

## Antes de staging e produção

1. Obter esquema sanitizado do ambiente atual. O repositório não contém o predecessor completo; não basta executar as migrações em um banco vazio.
2. Rodar e revisar a pré-auditoria em uma cópia autorizada. Contagem bloqueada ou tipo incompatível não é aprovação. Conferir policies/grants antigos e dois tenants.
3. Aplicar e testar as migrações 300 → 400 → 500 em staging, com backup/restore. A 400 exige publicação Supabase Realtime existente e RLS de mensagens ativa; não presume que as policies sejam corretas.
4. Validar Realtime com JWTs sintéticos, isolamento entre organizações, reconexão e remoção de usuários. Os testes locais de publicação são somente de catálogo.
5. Classificar explicitamente os números em setores e validar somente números de teste. Evolution/Instagram continuam sem transporte substituto ou fallback; a função implementada usa a API oficial Meta. Templates fora da janela de 24h ainda exigem implementação/configuração própria.
6. Implantar UI, funções e migrações em conjunto quando autorizado. Consumidores antigos `patient_id/text` são incompatíveis; novos clientes precisam `request_id/conversation_id/channel_id/text`.
7. Definir reconciliação operacional e desbloqueio auditado de tentativas desconhecidas antes de produção. O estado conservador pode bloquear uma conversa quando só existe marcador local e o resultado ainda não foi localizado. Não limpar cache nem criar novo UUID para contornar a incerteza. Ver `CRM-OUTBOUND-SAFETY.md`.
8. Validar concorrência real de múltiplas conexões/workers e os fluxos completos com a equipe. PGlite e mocks não comprovam infraestrutura distribuída.

## Revisão independente

Defeitos reproduzidos e corrigidos incluem grants `TRUNCATE` herdados apesar de RLS, ID de pendência mutável, perda de evidência de aceite tardio, perda de UUID após recarga/cache de navegação, sobrescrita de marcador por outra aba, página histórica HTTP 416 e lacunas no inventário de permissões da outbox. Regressões acompanham as correções.
