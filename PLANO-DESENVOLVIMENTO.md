# Plano de Desenvolvimento v2 — ClinPrime CRM

> **Documento vivo.** Atualizado em 19/07/2026, após a migração completa pra Next.js.
> Objetivo: (1) operação da ClinPrime redonda e lucrativa → (2) produto SaaS vendável pra outras clínicas.
> Referência de mercado: DKW System / WeSales.

---

## O que JÁ está pronto (v1 concluída)

- ✅ Multi-tenant no Supabase (orgs, RLS `is_org_member`, views com `security_invoker`)
- ✅ Frontend 100% Next.js 16 + React 19 + Tailwind v4 + shadcn/ui, no ar em crmclinprime.vercel.app
- ✅ 10 telas: Dashboard, Funil (kanban dinâmico), Pacientes, Multiatendimento (Realtime), Metas & Vendas, Follow-up, Agenda, Automações, Conexões, Configurações
- ✅ Integração Clinicorp completa: agenda (criar/cancelar/marcar), vendas/faturamento (estimates), financeiro (cash flow), badge de orçamento no funil, sync com botão manual + automático
- ✅ Regra do funil CRC/Layla (configurável pela UI), cadência de faltas (pg_cron, desligada aguardando textos)
- ✅ Inbox PRO: respostas rápidas, tags, atribuição, painel lateral, IA×Humano unificado com o bot
- ✅ Builder de automações, QR polling nas conexões, ficha/edição/exclusão de pacientes

---

## FASE 0 — Segurança & Estabilidade *(esta semana — bloqueia o resto)*

*Proteger o que já funciona. Itens 0.1–0.3 e 0.6 dependem do Thiago; o resto é dev.*

| # | Item | Quem | Esforço | Critério de aceite |
|---|------|------|---------|--------------------|
| 0.1 | **Repo privado** no GitHub (chaves vazaram no histórico) | Thiago | 2 min | Repo inacessível deslogado |
| 0.2 | **Rotacionar chave ElevenLabs** → me passar a nova | Thiago + dev | 15 min | Nova chave no nó do wf 003; antiga revogada |
| 0.3 | **Rotacionar chave Dify** → atualizar n8n + `platform_settings.dify_key` | Thiago + dev | 30 min | Sofia responde; investigar o **502 do Copilot** na mesma tacada |
| 0.4 | **Health-check com alerta**: edge function + pg_cron (10 min) que verifica (a) última mensagem processada pelo bot, (b) status da instância Evolution, (c) último sync Clinicorp — e manda WhatsApp pro Thiago quando degradar | dev | ½ dia | Simular queda → alerta chega no WhatsApp em ≤10 min |
| 0.5 | **Ensaio de restore** do backup do Supabase (nunca testado) | dev | 2 h | Restore num projeto de teste, dados íntegros |
| 0.6 | Trocar a senha do CRM (circulou em sessões de trabalho) | Thiago | 1 min | — |

**Total dev: ~1 dia.**

---

## FASE 1 — Inteligência de Dinheiro *(semana 1–2 — maior retorno por esforço)*

*Responder à pergunta que paga as contas: qual campanha/origem gera venda?*

### 1.1 Relatório de ROI por origem/campanha ⭐
- Nova tela **"Resultados"**: funil por origem — leads → agendados → compareceram → orçamento → aprovados → **R$** (período selecionável).
- RPC `get_source_funnel(org, from, to)` cruzando `crm_patients.source` × `crm_attendances` × `crm_estimates` (match por `phone_canon`, já existe).
- **Pré-requisito:** normalizar `source` na importação de leads — gravar o **nome da campanha** vindo da planilha do Meta, não só "Instagram".
- Aceite: tela mostra, por campanha, conversão etapa a etapa e receita; números batem com conferência manual de 1 campanha.
- Esforço: **2 dias**.

### 1.2 Tempo de primeira resposta
- Métrica por conversa: delta entre 1ª mensagem inbound e 1ª resposta (bot ou humano). Card no Dashboard + lista de "leads esperando há mais de X min".
- Esforço: **1 dia**.

### 1.3 Motivo de perda
- Campo `lost_reason` no deal; ao marcar orçamento reprovado/perdido, modal pede o motivo (preço / sumiu / concorrente / outro).
- Relatório simples de motivos no Metas.
- Esforço: **1 dia**.

**Total: ~4 dias.**

---

## FASE 2 — Operação Diária *(semana 2–3 — a dor da Layla)*

### 2.1 Notificações 🔔
- **No app:** título da aba pisca + som + badge de não-lidas ao chegar mensagem (Realtime já entrega o evento).
- **Notification API** do navegador (permissão em 1 clique).
- **Resumo pró-ativo:** pg_cron manda WhatsApp pro Thiago (via Evolution) — "resumo do dia: X leads novos, Y sem resposta". Configurável em Configurações.
- Esforço: **1½ dia**.

### 2.2 Áudio no inbox 🎤
- Renderizar mensagens de áudio recebidas com player (verificar como o 003 guarda a mídia; se só transcreve, exibir a transcrição identificada como áudio).
- Fase b (depois): enviar áudio pelo CRM.
- Esforço: **1–2 dias** (depende do que o 003 salva).

### 2.3 Notas + tarefas por paciente 📝
- Tabelas `crm_notes` (texto, autor, data) e `crm_tasks` (descrição, due_date, done).
- UI na ficha do paciente + painel lateral do inbox; card "Tarefas de hoje" no Dashboard.
- Esforço: **1½ dia**.

### 2.4 Agendar de dentro do inbox 📅
- Botão "Agendar" no painel lateral reusa o `NewAppointmentDialog` (nome/telefone pré-preenchidos).
- Esforço: **½ dia**.

### 2.5 Mobile (PWA) 📱
- `manifest.json` + ícone (instalável na tela inicial), layout responsivo priorizando **Inbox** e **Funil**; sidebar vira menu hambúrguer.
- Esforço: **2 dias**.

**Total: ~7 dias.**

---

## FASE 3 — SaaS Core *(semana 4–6 — só depois da operação redonda)*

### 3.0 Decisão estratégica (antes de codar): o CRM exige Clinicorp?
- **Recomendação:** modo standalone — org sem Clinicorp esconde/degrada as telas de agenda/vendas Clinicorp e usa agenda própria. Mercado 10x maior.
- Implementação: feature flag por org (`settings.integrations.clinicorp = on/off`).

### 3.1 Convite de membros por e-mail
- Edge function admin (`inviteUserByEmail` do Supabase Auth) + tela Equipe ganha "Convidar" (e-mail + papel). Fluxo de definir senha no primeiro acesso.
- Esforço: **1 dia**.

### 3.2 Onboarding wizard
- Passos: criar conta → criar organização → conectar WhatsApp (QR) → importar contatos (CSV) → configurar funil (template) → pronto.
- Esforço: **3–4 dias**.

### 3.3 Billing
- **Recomendação: Asaas** (PIX + cartão + boleto, Brasil-first) — alternativa Stripe.
- Planos (ex.: Start / Pro / Clínica+), webhook de pagamento → `organizations.plan`, gates por plano (nº de usuários, canais, automações).
- Esforço: **4–5 dias**.

### 3.4 White-label
- Tema por org: cores primárias + logo (já existe `logo_url`) via CSS vars; subdomínio por cliente (`clinica.clinprime.app`) com wildcard na Vercel.
- Esforço: **2–3 dias**.

### 3.5 Instagram real
- App Meta + OAuth + Instagram Messaging API na inbox. **⚠️ App Review da Meta leva semanas — iniciar o processo no começo da Fase 3, em paralelo.**
- Esforço: **3–4 dias de dev** + espera do review.

**Total: ~3 semanas de dev + review da Meta.**

---

## FASE 4 — Melhoria Contínua *(sem prazo, por demanda)*

- Mídia completa no inbox (imagem/documento, envio de mídia)
- Relatórios de atendimento (conversas/atendente, tempo médio, conversão por atendente)
- **LGPD** (crítico antes de escalar: consentimento no primeiro contato, exportação e exclusão de dados — dado de saúde é sensível)
- Campanhas em massa com anti-ban (aproveitar o motor da cadência)
- Cadência de faltas: **ligar** (aguarda textos do Thiago — infra pronta)
- Google Calendar (para clínicas sem Clinicorp)
- Central de ajuda / docs do produto
- Testes automatizados (e2e das 5 jornadas principais)

---

## Ordem de execução resumida

```
AGORA    → Fase 0 (segurança/alertas)            ~1 dia dev + 20 min Thiago
Semana 1 → Fase 1 (ROI + resposta + perda)       ~4 dias
Semana 2 → Fase 2 (notificações, áudio, notas,   ~7 dias
            agendar no chat, PWA)
Semana 4 → Fase 3 (SaaS: convites, onboarding,   ~3 semanas
            billing, white-label, Instagram)      + App Review Meta
Contínuo → Fase 4
```

## Dependências do Thiago (ninguém mais pode fazer)

1. Tornar o repo privado (2 min) — **hoje**
2. Rotacionar chaves ElevenLabs e Dify e me passar as novas (15 min)
3. Trocar a senha do CRM (1 min)
4. Aprovar os textos da cadência de faltas (quando quiser ligá-la)
5. Confirmar se a planilha de leads traz o **nome da campanha** (pré-requisito do relatório de ROI)
6. Decidir: produto exige Clinicorp ou terá modo standalone? (antes da Fase 3)
7. Criar conta Asaas (ou Stripe) quando chegar o billing
