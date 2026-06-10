# Plano de Desenvolvimento — ClinPrime CRM → SaaS Comercializável

> Objetivo: transformar o CRM atual (single-tenant, focado na ClinPrime) num produto SaaS
> multi-empresa que qualquer cliente conecta o **WhatsApp e o Instagram**, com login,
> planos e automação — referência de mercado: DKW System / WeSales.

---

## PARTE 1 — Auditoria seção por seção (estado atual)

### Legenda
✅ pronto para uso interno · ⚠️ funciona mas não está pronto para consumidor final · ❌ não existe

| # | Seção | Estado | O que falta para o consumidor final |
|---|-------|--------|--------------------------------------|
| 1 | **Login / Autenticação** | ❌ | Não existe. A chave anon do Supabase está exposta no front e **sem RLS** — qualquer pessoa com a URL acessa todos os dados. É o item mais crítico. |
| 2 | **Dashboard** | ⚠️ | KPIs carregam dados reais, mas os comparativos ("+22.4% este mês") são texto fixo fake. Faturamento sempre R$ 0 (não há fonte de valores). Precisa de métricas reais calculadas por período. |
| 3 | **Pipeline (Kanban)** | ⚠️ | Drag-and-drop funciona e persiste. Mas as 7 etapas são fixas no código — cada cliente precisa criar/renomear as suas. Falta: valor por card, filtros, motivos de perda. |
| 4 | **Contatos** | ⚠️ | CRUD funciona. "Simular Lead Ads" é botão de demonstração. Terminologia "paciente/tratamento" é fixa do nicho odonto — precisa ser configurável (lead/cliente/aluno...). Falta importação CSV. |
| 5 | **Multiatendimento** | ⚠️ | ✅ Realtime (WebSocket) funcionando, toggle IA×Humano funcionando. Falta: envio real ativado (webhook n8n importado mas inativo), renderizar áudio/imagem (hoje só texto), abas Instagram/E-mail são decorativas, sem atribuição de atendente, sem filas, sem tags, sem busca. |
| 6 | **Automação** | ⚠️ | Painel lista regras do Supabase e dispara simulações. Os 7 workflows n8n do CRM estão importados porém inativos. Sem builder visual (gatilho→condição→ação). |
| 7 | **Agenda** | ⚠️ | Renderiza consultas criadas no CRM. Sem integração com Google Calendar nem Clinicorp no front. Sem visão semanal/mensal real. |
| 8 | **IA no painel (copilot)** | ❌ | As respostas do painel de IA são **hardcoded no front** (fake). A Sofia real vive no Dify+n8n, desconectada do painel. Precisa de API real por tenant. |
| 9 | **Backend (server/)** | ⚠️ | Express completo (rotas, Evolution, n8n) mas **não é usado** — o front fala direto com o Supabase. `.env` com placeholders (service key, Evolution key). Decidir: ativar o backend ou aprofundar o modelo serverless com RLS. |
| 10 | **Automação de produção (Sofia)** | ⚠️ | O fluxo real é o `003 FIXING` no n8n (não os templates). Funciona, mas: 1 instância Evolution fixa, 1 agente Dify fixo, filtro de teste limita a 1 número, e o worker `webhook.clinprime.shop` está travado (mensagens novas não chegam!). O Supabase que ele grava é um **terceiro projeto**, diferente do CRM — dados fragmentados. |

### Conclusão da auditoria
O produto hoje é um **MVP interno de nicho** com boa base visual e automação real funcionando para 1 cliente (ClinPrime). Para comercializar faltam 4 pilares: **(a)** autenticação/multi-tenant com RLS, **(b)** conexão self-service de canais (WhatsApp + Instagram) por cliente, **(c)** automação genérica (não hardcoded por cliente), **(d)** billing/onboarding.

---

## PARTE 2 — Plano de desenvolvimento por fases

### FASE 0 — Estabilização do que existe (≈1 semana)
*Sem isso, nem o cliente atual funciona direito.*

- [ ] **Consertar/reapontar o worker de webhook** — `webhook.clinprime.shop` travado em "starting up"; reapontar Evolution → `n8n.clinprime.shop` ou reiniciar o container.
- [ ] **Unificar o Supabase** — hoje são 3 projetos (CRM `sterdootrqzlnbbidkcj`, produção da Sofia em outro, mais um ocioso). Migrar tudo para UM projeto.
- [ ] Ativar os 7 workflows n8n do CRM (envio de mensagem, boas-vindas, reengajamento...).
- [ ] Remover `FiltroLeticiaTest` quando for liberar para todos os números.
- [ ] Preencher secrets do `.env` (service key, Evolution key) e tirar do repositório público qualquer chave.
- [ ] ⚠️ **Repositório é público no GitHub com a anon key commitada** — tornar privado já.

### FASE 1 — Fundação SaaS: auth + multi-tenant (≈2–3 semanas)
*O alicerce de tudo. Nada de comercial existe sem isso.*

- [ ] **Supabase Auth**: login e-mail/senha, recuperação, convite de membros.
- [ ] Modelo de dados multi-tenant:
  - `organizations` (tenant) · `org_members` (papéis: admin, gestor, atendente)
  - `tenant_id` em TODAS as tabelas (patients, deals, messages, chats, ...)
- [ ] **RLS (Row Level Security)** em todas as tabelas: usuário só vê dados da própria organização. Isso elimina o problema da anon key exposta.
- [ ] Renomear domínio do vocabulário: `patients` → `contacts` com rótulo configurável por tenant ("Paciente", "Lead", "Aluno"...).
- [ ] Tela de configurações da organização (nome, logo, etapas do funil customizáveis).
- [ ] Decisão de front: manter vanilla JS no curto prazo (mais rápido) e planejar migração para **Next.js + React** na Fase 4/5 (necessário p/ white label e escala de UI).

### FASE 2 — Conexão de canais self-service (≈2–3 semanas)
*O coração do produto: cada cliente conecta seu próprio WhatsApp e Instagram.*

**WhatsApp (via Evolution API):**
- [ ] Tela "Conexões": botão **Conectar WhatsApp** → cria instância Evolution via API (`POST /instance/create` com nome = tenant) → exibe **QR Code no próprio CRM** → mostra status (conectado/desconectado/bateria).
- [ ] 1 instância Evolution por tenant; webhook de TODAS as instâncias aponta para UM workflow n8n genérico.
- [ ] **Workflow n8n multi-tenant**: resolve o tenant pelo nome da instância (lookup no Supabase) e carrega configurações do tenant (agente IA, funil, mensagens) dinamicamente — fim do hardcode por cliente.
- [ ] Risco a gerenciar: Evolution = API não-oficial (Baileys), risco de banimento. Roadmap: oferecer também **WhatsApp Cloud API oficial** (Meta) como opção premium.

**Instagram (via Meta Graph API):**
- [ ] App Meta (Facebook Developers) com produto **Instagram Messaging**.
- [ ] OAuth: cliente clica "Conectar Instagram" → login Meta → concede permissão à página/conta business.
- [ ] Webhook de DMs do Instagram → mesmo pipeline n8n → mesma inbox.
- [ ] Normalizador de canal: cada mensagem carrega `channel: whatsapp|instagram`, e a inbox mostra o ícone correspondente (as abas que hoje são decorativas passam a funcionar).
- [ ] Automação de comentários/stories (referência DKW) — fase posterior, requer permissões adicionais do app Meta.

### FASE 3 — Multiatendimento nível mercado (≈2 semanas)
*Transformar o chat atual num inbox de equipe de verdade.*

- [ ] Ativar envio real (workflows `enviar-whatsapp` ativos) — texto primeiro, depois mídia.
- [ ] Renderizar e enviar **áudio, imagem, documento** no chat.
- [ ] **Filas e atribuição**: distribuir conversas entre atendentes, "puxar para mim", transferir.
- [ ] Tags coloridas, busca, filtros (não lidas / minhas / sem atendente).
- [ ] Notas internas na conversa (invisíveis ao cliente).
- [ ] Respostas rápidas/templates por tenant.
- [ ] **IA por tenant**: cada organização configura seu agente (prompt próprio no Dify ou motor próprio via API). O toggle IA×Humano já está pronto ✅.

### FASE 4 — Automação comercializável (≈2–3 semanas)

- [ ] **Builder de automação no CRM** (gatilho → condição → ação) salvo no Supabase e executado pelo motor n8n genérico. Gatilhos: nova mensagem, mudança de etapa, tag adicionada, inatividade. Ações: enviar mensagem, mover etapa, adicionar tag, notificar atendente, webhook.
- [ ] **Campanhas em massa** com aquecimento, intervalos aleatórios e limites anti-ban.
- [ ] Cadência de follow-up (sequências: dia 0, dia 1, dia 3...).
- [ ] Relatórios: conversas por atendente, tempo de resposta, conversão por etapa.

### FASE 5 — Produto e comercialização (≈2 semanas)

- [ ] **Billing**: assinaturas via Stripe ou Asaas. Planos com limites (usuários, contatos, instâncias, mensagens IA) — espelhar a estrutura do DKW (Básico/Pro/Enterprise).
- [ ] **Onboarding wizard**: criar conta → conectar WhatsApp (QR) → importar contatos → configurar funil → primeira automação.
- [ ] **White label** (diferencial DKW): logo, cores e domínio próprio por parceiro (exige front em Next.js — motivo da migração planejada).
- [ ] Landing page, termos de uso, política de privacidade.
- [ ] **LGPD**: consentimento, exportação e exclusão de dados por contato (crítico — dados de saúde no nicho odonto são dados sensíveis).

---

## Arquitetura-alvo (resumo)

```
Cliente (browser)
  └─ Front (Next.js futuramente; vanilla JS no início) + Supabase Auth (JWT)
        └─ Supabase (1 projeto único)
             ├─ RLS por tenant_id  ← segurança real
             ├─ Realtime (inbox ao vivo — já funciona)
             └─ Tabelas: organizations, org_members, contacts, deals,
                messages, channels, automations, subscriptions
n8n (1 conjunto de workflows GENÉRICOS, multi-tenant por lookup)
  ├─ Inbound WhatsApp (Evolution, 1 instância/tenant)
  ├─ Inbound Instagram (Meta Graph webhooks)
  ├─ Motor de automação (lê regras do Supabase)
  └─ IA por tenant (Dify ou API direta — prompt por organização)
Evolution API  ← instâncias criadas via API pelo próprio CRM
Meta App       ← OAuth Instagram por cliente
Stripe/Asaas   ← billing
```

## Cronograma estimado

| Fase | Duração | Acumulado |
|------|---------|-----------|
| 0 — Estabilização | 1 sem | 1 sem |
| 1 — Auth + multi-tenant | 2–3 sem | ~4 sem |
| 2 — Canais (WhatsApp + Instagram) | 2–3 sem | ~7 sem |
| 3 — Multiatendimento PRO | 2 sem | ~9 sem |
| 4 — Automação | 2–3 sem | ~11 sem |
| 5 — Produto/billing | 2 sem | **~13 sem (≈3 meses)** |

## Riscos principais

1. **Repo público com chaves** — resolver HOJE (Fase 0).
2. **Banimento WhatsApp** (API não-oficial) — mitigar com limites/aquecimento; oferecer Cloud API oficial depois.
3. **Aprovação do app Meta** para Instagram Messaging leva semanas (App Review) — iniciar o processo cedo, na Fase 1.
4. **LGPD com dados de saúde** — tratar desde a modelagem (Fase 1), não depois.
5. **Fragmentação atual de dados** (3 Supabases) — unificar antes de construir em cima.
