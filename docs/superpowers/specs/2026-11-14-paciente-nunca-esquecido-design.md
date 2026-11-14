# ClinPrime CRM — "Paciente nunca esquecido"

Design de 14/11/2026. Substitui o `PLANO-DESENVOLVIMENTO.md` como plano vigente.

## 1. Intenção

O CRM já integra Clinicorp e WhatsApp e tem 11 telas, mas depende da memória e da
disciplina da equipe. O resultado, nas palavras do Thiago:

- **CRC de leads:** o lead fala "oi" e some; marca e não comparece; ninguém entende a dor
  do paciente para saber se o caso pede urgência ou acolhimento.
- **Recepção:** o paciente sai da consulta sem próxima data; demandas ("vou ver um
  horário") levam 2 a 3 horas para serem respondidas.
- **CRC comercial:** não há cadência de fechamento para tratamento high-ticket, nem
  cadência individual por tipo e momento do paciente.
- **Pós-venda:** praticamente não existe; ninguém faz a tarefa todo dia ou toda semana.

O que ele espera: uso fácil e rápido, paciente nunca esquecido em nenhuma frente, e
encantamento no agendamento, no fechamento do contrato e durante o tratamento,
terminando em feedback que vire prova social.

## 2. Objetivos, não-objetivos e anti-objetivos

**Objetivos**

1. Todo paciente ativo tem sempre responsável, próxima ação e prazo. O sistema cobra isso.
2. Cada pessoa abre o sistema e vê uma fila única do que fazer agora, por frente:
   recepção, CRC de leads, CRC comercial, pós-venda.
3. O que é previsível sai sozinho; o que exige leitura do paciente vai para um humano
   com rascunho pronto.
4. Pós-venda funciona mesmo que ninguém lembre dele.
5. Dify sai do sistema.

**Não-objetivos (por ora)**

- Virar produto para outras clínicas: cobrança, white-label, onboarding, convite por e-mail.
- Instagram real via API da Meta.
- Agenda própria; a agenda continua sendo a do Clinicorp.

**Anti-objetivos (seria fracasso mesmo funcionando)**

- IA conversando sozinha com o paciente. Foi a abordagem descartada.
- Automação que leve ao bloqueio de um número de WhatsApp.
- Paciente recebendo mensagem automática por cima de uma conversa humana em andamento.
- Mais telas ou mais cliques do que hoje para fazer a mesma coisa.

## 3. Abordagens consideradas

| | Como funciona | Troca |
|---|---|---|
| A. Equipe envia tudo | Sistema monta fila e cobra prazo; IA rascunha; pessoa envia | Mais seguro, mas continua dependendo da disciplina que falha hoje |
| **B. Híbrido (escolhida)** | Previsível sai automático; o resto vai para a fila com rascunho | Pós-venda existe sem ninguém lembrar; venda continua humana |
| C. IA conversa sozinha | Agente atende; equipe só nas exceções | Tom errado custa fechamento high-ticket; é o modelo do bot abandonado |

Thiago escolheu **B** em 14/11/2026.

## 4. Restrições

- **WhatsApp:** envio automático só pela API oficial da Meta, com modelos aprovados.
  Os quatro números via Baileys (recepção, Layla, Diana, Thiago) ficam para envio
  humano. Fora da janela de 24 horas, a API oficial só aceita modelo aprovado.
- **Clinicorp:** continua sendo a fonte de agenda, orçamentos e financeiro, lido por
  sincronização (`supabase/functions/clinicorp-agenda`). O CRM não consegue impedir
  nada dentro do Clinicorp; só consegue cobrar aqui.
- **Dado de saúde:** a IA recebe o mínimo necessário da conversa. Depoimento só é
  usado como prova social com consentimento registrado.
- **Stack:** a existente. Next.js 16, React 19, Tailwind v4, shadcn/ui, Supabase
  (Postgres, RLS por organização, Realtime, edge functions, pg_cron).

## 5. Como funciona

### 5.1 Tarefa: a peça central

Uma tabela nova, `crm_tasks`, guarda tanto a "próxima ação" quanto a "demanda". São a
mesma coisa: algo que alguém deve fazer por um paciente até um prazo.

Campos: organização, paciente, frente (`recepcao`, `crc_leads`, `comercial`,
`pos_venda`), tipo (`demanda`, `proxima_acao`, `passo_cadencia`), título, responsável,
prazo, estado (`aberta`, `feita`, `adiada`, `cancelada`), origem (`manual`, `cadencia`,
`passagem`, `sistema`), rascunho de mensagem, resultado, quem concluiu e quando.

Regras:

- **Invariante:** paciente ativo tem pelo menos uma tarefa aberta. Uma rotina
  periódica encontra quem viola a regra e cria "Definir próxima ação" para o
  responsável; sem responsável, para o gestor.
- **Concluir exige o próximo passo:** ao marcar uma tarefa como feita, a pessoa
  informa a próxima ação e o prazo, ou encerra o paciente com motivo
  (em tratamento com retorno marcado, perdido com motivo, concluído).
- **Adiar exige nova data.**
- **Escalonamento:** tarefa vencida além da tolerância da frente aparece para o gestor.

### 5.2 Demanda com prazo (dor da recepção)

Qualquer mensagem no Inbox vira demanda com um clique. Nasce com responsável (quem
clicou) e prazo padrão da frente. Prazo inicial proposto: 30 minutos na recepção,
configurável. Ao estourar: notificação no app para o responsável e subida para o gestor.

### 5.3 Retorno obrigatório (dor da recepção)

Quando a sincronização do Clinicorp marca uma consulta como "compareceu" e o paciente
não tem consulta futura, o sistema cria "Agendar retorno" para a recepção, com prazo no
mesmo dia. Só fecha com consulta futura existente ou motivo registrado.

### 5.4 Leitura do paciente

Campos novos na ficha: dor principal, objeção, momento (`curioso`, `considerando`,
`decidido`, `esfriou`), tratamento de interesse, faixa (`high-ticket` ou `padrão`),
tom recomendado (`acolhimento` ou `urgência`).

A IA lê a conversa e **sugere** os valores; a pessoa confirma ou corrige com um clique.
Esses campos escolhem a cadência e alimentam os rascunhos.

### 5.5 Cadências

Hoje `cadence-runner` executa uma única cadência fixa (`resgate_falta`). Passa a
executar qualquer cadência de `crm_cadences`, reaproveitando
`crm_cadence_enrollments` e a lógica de horário comercial que já existe.

Cada passo tem: espera desde o passo anterior, modo (`automatico` ou `humano`), e ou
um modelo de mensagem aprovado (automático) ou uma instrução para o rascunho (humano).

- Passo automático: envia pela API oficial e registra na linha do tempo.
- Passo humano: cria tarefa na fila da frente, com rascunho.
- **Parada:** a cadência pausa quando o paciente responde, quando ele muda de frente,
  quando pede para não receber mensagens, ou quando um humano escreveu para ele nas
  últimas horas (tolerância configurável).

Cadências iniciais:

| Cadência | Gatilho | Frente |
|---|---|---|
| Lead sumiu | Lead sem resposta após o primeiro contato | CRC leads |
| Confirmação de consulta | Consulta marcada | Recepção |
| Resgate de falta | Consulta marcada como falta | CRC leads |
| Orçamento em aberto | Orçamento criado no Clinicorp, faixa padrão | Comercial |
| Fechamento high-ticket | Orçamento criado, faixa high-ticket | Comercial |
| Boas-vindas ao tratamento | Orçamento aprovado | Pós-venda |
| Acompanhamento do tratamento | Marcos após a aprovação | Pós-venda |
| Satisfação e depoimento | Marco definido do tratamento | Pós-venda |
| Reativação | Paciente sem consulta há muito tempo | Pós-venda |

As duas cadências comerciais e a de lead sumiu têm variantes por tom
(acolhimento ou urgência), escolhidas pelo campo da ficha.

### 5.6 Passagem de bastão

Eventos que mudam a frente do paciente, encerram a cadência anterior e criam a
primeira tarefa da frente seguinte:

| Evento | De → Para |
|---|---|
| Lead agenda consulta | CRC leads → Recepção |
| Falta à consulta | Recepção → CRC leads |
| Orçamento criado no Clinicorp | Recepção → Comercial |
| Orçamento aprovado | Comercial → Pós-venda |
| Orçamento perdido (motivo obrigatório) | Comercial → Pós-venda (reativação) |

### 5.7 Pós-venda, encantamento e prova social

- A fila de pós-venda nasce pronta todo dia a partir das cadências; ninguém precisa montar.
- Pesquisa de satisfação de 0 a 10 por WhatsApp em marco definido.
  - Nota 9 ou 10: pedido de depoimento (texto, vídeo ou avaliação no Google).
  - Nota 6 ou menos: demanda urgente para o gestor.
- Tabela `crm_feedback`: paciente, nota, comentário, depoimento, e consentimento de
  uso como prova social (sim ou não, com data).
- Tela simples lista os depoimentos autorizados para o marketing usar.

### 5.8 IA sem Dify

`supabase/functions/dify-proxy` e a chamada em `components/copilot/copilot.tsx` saem.
Entra uma edge function que chama a API da Anthropic direto, com três usos:

1. Rascunhar a mensagem de uma tarefa, usando a ficha e as últimas mensagens.
2. Sugerir dor, objeção, momento e tom a partir da conversa.
3. Resumir o paciente em poucas linhas no topo da linha do tempo.

A IA nunca envia mensagem. Chave em segredo do Supabase; modelo definido em configuração.

## 6. Layout

Navegação cai de 11 itens para 8:

| Item | Conteúdo | Origem |
|---|---|---|
| **Minha fila** (tela inicial) | Tarefas da pessoa, vencidas primeiro, com abas por frente | Nova; absorve Follow-up |
| Conversas | Inbox atual, com botão "virar demanda" e painel do paciente | Multiatendimento |
| Pacientes | Lista e ficha com linha do tempo | Pacientes |
| Agenda | Como hoje | Agenda Clínica |
| Funil | Kanban atual | Funil de Tratamentos |
| Cadências | Lista, passos, liga e desliga | Automações |
| Gestão | Esquecidos, prazos por frente e por pessoa, metas, ROI | Dashboard, Metas, Resultados |
| Configurações | Organização, equipe, frentes, prazos, conexões | Configurações, Conexões |

**Minha fila.** Cada linha mostra paciente, por que está ali, o que fazer e o prazo. Ao
abrir: rascunho editável e os botões Enviar, Feito e Adiar. Enviar e Feito pedem a
próxima ação na mesma caixa. Pensada para ser operada só com o teclado.

**Ficha do paciente.** Cabeçalho fixo com responsável, frente, próxima ação, prazo,
momento e tom. Abaixo, uma linha do tempo única: mensagens, consultas, orçamentos,
tarefas, passos de cadência e mudanças de frente. Abre como painel lateral a partir de
qualquer tela, reaproveitando `PatientFichaDialog`.

**Gestão.** Primeiro bloco: "Esquecidos" (sem próxima ação ou com prazo vencido), por
frente e por pessoa. Depois tempo de resposta a demandas, e então metas e ROI, que já existem.

Visual: mantém shadcn/ui e Tailwind e o padrão de cards e botões do último commit.
Fila e Conversas precisam funcionar bem no celular.

## 7. Ordem de entrega

Cada fase entrega algo utilizável sozinha.

1. **Fundação.** `crm_tasks`, invariante, Minha fila, linha do tempo, demanda com
   prazo, navegação nova. Resolve a demora da recepção e torna o esquecimento visível.
2. **Cadências e passagens.** Motor genérico, passagem de bastão, retorno obrigatório,
   e as cadências de lead sumiu, confirmação e resgate de falta.
3. **IA sem Dify.** Rascunhos, leitura do paciente, cadências comerciais e high-ticket.
4. **Pós-venda.** Boas-vindas, acompanhamento, satisfação, depoimentos.
5. **Gestão.** Painel de esquecidos e de prazos.

## 8. Decisões do Thiago (como ele decidiu)

- Abordagem híbrida (B).
- Dify sai.
- Quatro frentes: recepção, CRC de leads, CRC comercial, pós-venda.
- A regra "responsável, próxima ação e prazo" e a fila por frente ("achei perfeito").
- Não existe bot respondendo sozinho hoje. O botão de IA por conversa no Inbox e o
  campo `chats.ai_service` são sobra e saem na fase 1.
- Avaliações são feitas pelo Dr. Thiago e, às vezes, pela Dra. Thalita. O restante dos
  atendimentos é de todos os profissionais. Logo: a sincronização do Clinicorp passa a
  cobrir todos os profissionais (hoje filtra um), e "avaliação" é a consulta desses dois.
- High-ticket é orçamento acima de R$ 5.000.
- Não há número na API oficial da Meta. Os números estão em uma VPS com Baileys
  (ou `wacli`, que usa o mesmo protocolo não oficial e tem o mesmo risco de bloqueio).

**Consequência da última decisão:** enquanto não houver número oficial, nenhum passo é
enviado sozinho. A abordagem híbrida começa como "fila pronta com rascunho e envio em
um clique": o sistema monta e cobra todo dia, mas alguém precisa clicar. O envio
automático liga quando o número oficial existir, sem refazer as cadências.

## 9. Escolhas minhas (podem ser recusadas)

- Uma tabela só para demanda e próxima ação.
- Prazo padrão de demanda da recepção: 30 minutos.
- Corte da satisfação: 9 e 10 pedem depoimento; 6 ou menos vira demanda urgente.
- Valores de "momento" e "tom" listados em 5.4.
- Navegação de 8 itens e Minha fila como tela inicial.
- Produto para outras clínicas fica fora por ora.
- IA chamando a API da Anthropic direto.
- Ordem das fases.
- **Paciente ativo:** quem teve mensagem, consulta ou orçamento em aberto nos últimos
  90 dias. Os demais contatos (incluindo o histórico importado do WhatsApp) não recebem
  tarefa na carga inicial; ficam disponíveis para a cadência de reativação.
- **Sem número oficial aprovado:** todo passo automático roda como passo humano
  (tarefa com rascunho e envio em um clique). Nenhum envio automático sai por Baileys,
  o que inclui o `resgate_falta` atual. Quando o número oficial existir, as respostas a
  ele chegam em Conversas como qualquer outro canal e são respondidas ali.
- **Sincronização do Clinicorp:** agendada a cada 15 minutos, além do botão manual,
  para que "retorno no mesmo dia" e a confirmação funcionem.
- **Orçamento perdido:** marcado por uma pessoa no CRM, com motivo. Orçamento em aberto
  há mais de 30 dias gera a tarefa "fechar ou marcar como perdido".
- **Frente:** o paciente tem uma frente principal, mostrada no cabeçalho. Tarefas e
  cadências carregam a própria frente, então um paciente em tratamento que recebe novo
  orçamento tem tarefa comercial sem perder o acompanhamento. A passagem de bastão
  encerra só as cadências da frente que ele está deixando.
- **Faixa:** definida automaticamente pelo valor do orçamento na criação, com um
  valor de corte configurável; a pessoa pode corrigir depois.

## 10. Em aberto para o Thiago

Podem ser respondidas durante a construção:

1. Quem da equipe fica em cada frente, e quem é o gestor que recebe o que estoura?
2. Os textos das cadências: proponho que eu escreva a primeira versão e ele aprove
   antes de qualquer cadência ser ligada.
3. Quais são os marcos do tratamento que disparam acompanhamento e pesquisa de satisfação?
4. Contratar um número na API oficial da Meta, para que os passos previsíveis passem a
   sair sozinhos. O repositório já tem o cadastro (`whatsapp-onboard`).

## 11. Deixado para quem for construir

- Confirmar qual conjunto de tabelas é o vigente: o código usa tanto `patients`,
  `deals`, `messages`, `chats` quanto `crm_patients`, `crm_deals`, `crm_messages`.
  Verificar no banco se um deles é view do outro antes de modelar `crm_tasks`.
- Como a frente e o papel de gestor entram em `org_members`.
- Forma exata de cada passo de cadência no JSON de `crm_cadences.steps`.
- Mecanismo de notificação no app (Realtime já está em uso no Inbox).
- Destino dos fluxos em `n8n-workflows/` que hoje fazem boas-vindas, confirmação e
  reengajamento: ficam desligados quando a cadência equivalente entrar, para o
  paciente não receber em dobro.
- Testes: uma verificação por regra de 5.1 e por condição de parada de 5.5.
