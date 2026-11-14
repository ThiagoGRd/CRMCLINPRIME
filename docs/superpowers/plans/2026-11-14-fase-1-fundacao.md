# Fase 1 — Fundação ("Paciente nunca esquecido") Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dar a cada pessoa uma fila única de tarefas por frente, com demanda com prazo, conclusão que exige próximo passo, linha do tempo do paciente e a navegação de 8 itens.

**Architecture:** Uma tabela nova `crm_tasks` no Supabase, com RLS por organização igual às demais. A regra "concluir exige próximo passo" vive numa função SQL (`complete_task`), para valer qualquer que seja a tela. A lógica de prazo e ordenação fica em funções puras em `lib/tasks.ts`, testadas com `node:test`; as telas só consomem.

**Tech Stack:** Next.js 16, React 19, Tailwind v4, shadcn/ui (`components/ui`), `@tanstack/react-query`, Supabase (Postgres 17, RLS, Realtime, edge functions em Deno), `node:test`.

**Spec:** `docs/superpowers/specs/2026-11-14-paciente-nunca-esquecido-design.md` (seções 5.1, 5.2, 6 e fase 1 da seção 7). As fases 2 a 5 terão planos próprios.

## Global Constraints

- Banco: projeto Supabase `sterdootrqzlnbbidkcj`. É o banco de produção e não há outro. Toda migração é só aditiva (nada de `drop` nem `alter ... type`), fica em `supabase/migrations/` e **só é aplicada depois do "pode aplicar" do Thiago**.
- Tabelas reais têm prefixo `crm_`. `patients`, `messages`, `deals`, `pipeline_stages`, `activity_logs` são views com `security_invoker=on`; o frontend lê por elas.
- RLS de toda tabela nova: uma política `for all using (is_org_member(org_id)) with check (is_org_member(org_id))`.
- Responsável do paciente é a coluna que já existe: `crm_patients.assigned_to`.
- Frentes, valores exatos: `recepcao`, `crc_leads`, `comercial`, `pos_venda`.
- Prazo padrão de demanda, em minutos: recepção 30, CRC leads 60, comercial 120, pós-venda 1440. Sobrescrito por `organizations.settings.sla[frente]`.
- "Hoje" e "vencida" são calculados no fuso `America/Sao_Paulo`.
- Nenhum envio de WhatsApp novo nesta fase. Nenhuma IA nesta fase. Dify só sai na fase 3.
- Sem dependência nova no `package.json`.
- Textos de tela em português do Brasil.
- Testes: `node --require ./tests/register.cjs --test tests/*.test.mjs tests/*.test.ts tests/*.test.tsx tests/*.test.cjs`. Antes de cada commit: esse comando e `npm run lint`.

## Desvios do spec, decididos aqui

- **Sem tarefa automática "Definir próxima ação".** Há 1.111 pacientes com mensagem nos últimos 90 dias e um único usuário cadastrado; gerar uma tarefa para cada um afogaria a fila no primeiro dia. Em vez disso, a view `crm_forgotten_patients` lista quem está ativo e sem tarefa aberta, e a fila mostra essa lista numa seção própria.
- **Sem estado `adiada`.** Adiar só troca o prazo e soma em `snooze_count`; a tarefa continua `aberta`.
- **Sem coluna de escalonamento.** "Estourou" é calculado (`due_at < now()`); o gestor vê todas as vencidas.
- **"Enviar" direto da fila fica para a fase 3**, junto com os rascunhos. Aqui a tarefa tem "Abrir conversa".
- **Follow-up** sai do menu mas a rota `/followup` continua, com link no topo da fila, até as cadências da fase 2 a substituírem.

## Review Focus

1. Duas pessoas concluem a mesma tarefa: a segunda recebe erro claro e não nasce uma segunda "próxima ação". (Task 1 e Task 3)
2. Próximo prazo no passado ou data inválida: recusado antes de chegar ao banco. (Task 2)
3. Tarefa sem responsável, ou cujo responsável saiu da equipe: aparece para o gestor em "Sem responsável", não some. (Task 2 e Task 4)
4. Mensagem só de mídia ou vazia vira demanda: título cai para "Demanda de {nome}". (Task 2)
5. Tarefa com prazo às 23h30 de Brasília: conta como "hoje", não como amanhã (UTC). (Task 2)

---

### Task 1: Banco — `crm_tasks`, frentes e conclusão atômica

**Files:**
- Create: `supabase/migrations/20261114000000_crm_tasks.sql`
- Create: `supabase/migrations/20261114000000_crm_tasks.verify.sql` (consultas de conferência, não é migração)

**Interfaces:**
- Produces:
  - Tabela `crm_tasks(id uuid pk default gen_random_uuid(), org_id uuid not null, patient_id uuid not null references crm_patients(id) on delete cascade, front text not null, kind text not null default 'proxima_acao', title text not null, owner_id uuid, due_at timestamptz not null, status text not null default 'aberta', origin text not null default 'manual', draft text, outcome text, source_message_id uuid, snooze_count int not null default 0, created_by uuid default auth.uid(), created_at timestamptz not null default now(), done_by uuid, done_at timestamptz)`.
    Checks: `front in ('recepcao','crc_leads','comercial','pos_venda')`, `kind in ('demanda','proxima_acao','passo_cadencia')`, `status in ('aberta','feita','cancelada')`, `origin in ('manual','cadencia','passagem','sistema')`, `length(trim(title)) > 0`.
    Índices: `(org_id, status, due_at)` e `(patient_id, status)`. Entra na publicação `supabase_realtime`.
  - `crm_patients`: `front text not null default 'crc_leads'` (mesmo check), `care_status text not null default 'ativo' check in ('ativo','encerrado')`, `care_closed_reason text`.
  - `org_members`: `front text` (mesmo check, aceita nulo), `is_manager boolean not null default false`.
  - View `patients` recriada com `create or replace view`, mesmas colunas na mesma ordem e, **no final**, `front, care_status, care_closed_reason`. Mantém `security_invoker=on`.
  - View `tasks` (`security_invoker=on`) = `select * from crm_tasks`.
  - View `crm_forgotten_patients` (`security_invoker=on`): `id, org_id, name, phone, front, assigned_to, last_message_at` de `crm_patients` onde `care_status='ativo'`, `last_message_at > now() - interval '90 days'` e não existe `crm_tasks` com `status='aberta'` para o paciente.
  - `complete_task(p_task uuid, p_outcome text, p_next_title text, p_next_due timestamptz, p_next_front text, p_close_reason text) returns uuid`, `security invoker`. Devolve o id da próxima tarefa, ou `null` quando encerra o paciente.

- [ ] **Step 1: Escrever o arquivo de conferência**

`20261114000000_crm_tasks.verify.sql` com estas consultas, cada uma devolvendo uma linha `ok boolean`:

```sql
select count(*) = 18 as ok from information_schema.columns where table_name = 'crm_tasks';
select bool_and(relrowsecurity) as ok from pg_class where relname = 'crm_tasks';
select count(*) = 1 as ok from pg_policies where tablename = 'crm_tasks' and qual = 'is_org_member(org_id)';
select count(*) = 3 as ok from information_schema.columns where table_name = 'patients' and column_name in ('front','care_status','care_closed_reason');
select count(*) = 1 as ok from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'crm_tasks';
```

- [ ] **Step 2: Escrever a migração**

Regras de `complete_task`, na ordem:

1. `update crm_tasks set status='feita', outcome=p_outcome, done_by=auth.uid(), done_at=now() where id=p_task and status='aberta' returning patient_id, org_id, front`. Nenhuma linha: `raise exception 'tarefa_ja_concluida'`.
2. Se `p_next_title` não é nulo: exige `p_next_due > now()`, senão `raise exception 'prazo_invalido'`. Insere a próxima tarefa (`kind='proxima_acao'`, `origin='manual'`, `owner_id=auth.uid()`, `front=coalesce(p_next_front, front da tarefa concluída)`) e devolve o id.
3. Senão, se `p_close_reason` não é vazio: `update crm_patients set care_status='encerrado', care_closed_reason=p_close_reason`; devolve `null`.
4. Senão: `raise exception 'proximo_passo_obrigatorio'`.

Tudo na mesma função, logo na mesma transação: se o passo 2, 3 ou 4 falha, o passo 1 é desfeito.

- [ ] **Step 3: Pedir ao Thiago o "pode aplicar" e aplicar**

Aplicar com a ferramenta de migração do Supabase no projeto `sterdootrqzlnbbidkcj`. Não aplicar sem a confirmação.

- [ ] **Step 4: Rodar a conferência**

Rodar cada consulta do `.verify.sql`. Esperado: `ok = true` em todas. Depois, numa transação com `rollback` no fim: inserir uma tarefa de teste, chamar `complete_task` duas vezes seguidas e confirmar que a segunda falha com `tarefa_ja_concluida`; chamar com tudo nulo e confirmar `proximo_passo_obrigatorio` com a tarefa ainda `aberta`.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20261114000000_crm_tasks.sql supabase/migrations/20261114000000_crm_tasks.verify.sql
git commit -m "feat(db): crm_tasks, patient fronts and atomic task completion"
```

---

### Task 2: Regras de tarefa em funções puras

**Files:**
- Create: `lib/tasks.ts`
- Test: `tests/tasks.test.ts`

**Interfaces:**
- Produces:

```ts
export type Front = "recepcao" | "crc_leads" | "comercial" | "pos_venda";
export type TaskKind = "demanda" | "proxima_acao" | "passo_cadencia";
export type Task = {
  id: string; patientId: string; patientName: string; patientPhone: string;
  front: Front; kind: TaskKind; title: string; ownerId: string | null;
  dueAt: string; status: "aberta" | "feita" | "cancelada"; draft: string | null;
};
export type Urgency = "vencida" | "hoje" | "futura";
export const FRONTS: { key: Front; label: string }[];          // Recepção, CRC Leads, Comercial, Pós-venda
export const DEFAULT_SLA_MIN: Record<Front, number>;            // 30, 60, 120, 1440
export function slaMinutes(front: Front, settings: Record<string, unknown> | null): number;
export function demandDueAt(now: Date, front: Front, settings: Record<string, unknown> | null): Date;
export function urgency(dueAt: string, now: Date): Urgency;     // fuso America/Sao_Paulo
export function sortQueue(tasks: Task[], now: Date): Task[];    // vencidas, hoje, futuras; dentro de cada, prazo crescente
export function demandTitle(messageContent: string | null, patientName: string): string;
export function validateCompletion(i: { nextTitle: string; nextDue: string; closeReason: string }, now: Date): string | null;
export function visibleTo(task: Task, me: { userId: string; isManager: boolean }, memberIds: string[]): boolean;
```

- [ ] **Step 1: Escrever os testes que falham**

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { slaMinutes, demandDueAt, urgency, sortQueue, demandTitle, validateCompletion, visibleTo } from "../lib/tasks.ts";

const now = new Date("2026-11-14T15:00:00-03:00");
const t = (id: string, dueAt: string, ownerId: string | null = "u1") =>
  ({ id, patientId: "p", patientName: "Ana", patientPhone: "", front: "recepcao", kind: "demanda", title: "x", ownerId, dueAt, status: "aberta", draft: null }) as const;

test("sla usa o padrão e aceita sobrescrita da organização", () => {
  assert.equal(slaMinutes("recepcao", null), 30);
  assert.equal(slaMinutes("pos_venda", {}), 1440);
  assert.equal(slaMinutes("recepcao", { sla: { recepcao: 15 } }), 15);
  assert.equal(slaMinutes("recepcao", { sla: { recepcao: "abc" } }), 30);
});
test("prazo da demanda é agora mais o sla", () => {
  assert.equal(demandDueAt(now, "recepcao", null).toISOString(), new Date("2026-11-14T15:30:00-03:00").toISOString());
});
test("23h30 de Brasília ainda é hoje", () => {
  assert.equal(urgency("2026-11-14T23:30:00-03:00", now), "hoje");
  assert.equal(urgency("2026-11-15T00:10:00-03:00", now), "futura");
  assert.equal(urgency("2026-11-14T14:59:00-03:00", now), "vencida");
});
test("fila: vencidas, depois hoje, depois futuras, por prazo", () => {
  const out = sortQueue([t("c", "2026-11-20T10:00:00-03:00"), t("b", "2026-11-14T18:00:00-03:00"), t("a2", "2026-11-14T12:00:00-03:00"), t("a1", "2026-11-13T12:00:00-03:00")], now);
  assert.deepEqual(out.map((x) => x.id), ["a1", "a2", "b", "c"]);
});
test("título da demanda cai para o nome quando não há texto", () => {
  assert.equal(demandTitle("  ", "Ana Souza"), "Demanda de Ana Souza");
  assert.equal(demandTitle(null, "Ana Souza"), "Demanda de Ana Souza");
  assert.equal(demandTitle("a".repeat(200), "Ana").length, 80);
  assert.equal(demandTitle("Quero remarcar", "Ana"), "Quero remarcar");
});
test("concluir exige próxima ação no futuro ou motivo de encerramento", () => {
  assert.equal(validateCompletion({ nextTitle: "", nextDue: "", closeReason: "" }, now), "Informe a próxima ação ou encerre o paciente com um motivo.");
  assert.equal(validateCompletion({ nextTitle: "Ligar", nextDue: "2026-11-14T10:00:00-03:00", closeReason: "" }, now), "O prazo da próxima ação precisa ser no futuro.");
  assert.equal(validateCompletion({ nextTitle: "Ligar", nextDue: "não é data", closeReason: "" }, now), "O prazo da próxima ação precisa ser no futuro.");
  assert.equal(validateCompletion({ nextTitle: "Ligar", nextDue: "2026-11-15T10:00:00-03:00", closeReason: "" }, now), null);
  assert.equal(validateCompletion({ nextTitle: "", nextDue: "", closeReason: "Perdido: preço" }, now), null);
});
test("tarefa sem responsável ou de quem saiu aparece só para o gestor", () => {
  const me = { userId: "u1", isManager: false }, boss = { userId: "u9", isManager: true };
  assert.equal(visibleTo(t("a", now.toISOString(), "u1"), me, ["u1", "u9"]), true);
  assert.equal(visibleTo(t("a", now.toISOString(), null), me, ["u1", "u9"]), false);
  assert.equal(visibleTo(t("a", now.toISOString(), null), boss, ["u1", "u9"]), true);
  assert.equal(visibleTo(t("a", now.toISOString(), "saiu"), boss, ["u1", "u9"]), true);
  assert.equal(visibleTo(t("a", now.toISOString(), "u1"), boss, ["u1", "u9"]), true);
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --require ./tests/register.cjs --test tests/tasks.test.ts`
Expected: FAIL, módulo `../lib/tasks.ts` não encontrado.

- [ ] **Step 3: Implementar `lib/tasks.ts`**

O dia de `urgency` é comparado com `Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" })`, sem biblioteca de datas.

- [ ] **Step 4: Rodar e ver passar**

Run: `node --require ./tests/register.cjs --test tests/tasks.test.ts`
Expected: PASS, 7 testes.

- [ ] **Step 5: Commit**

```bash
git add lib/tasks.ts tests/tasks.test.ts
git commit -m "feat(tasks): pure rules for deadlines, ordering and completion"
```

---

### Task 3: Acesso a dados das tarefas

**Files:**
- Create: `lib/tasks-data.ts`
- Test: `tests/tasks-data.test.mjs`

**Interfaces:**
- Consumes: `Task`, `Front`, `demandDueAt`, `demandTitle` de `lib/tasks.ts`; view `tasks`, view `crm_forgotten_patients`, função `complete_task` da Task 1.
- Produces:

```ts
export async function listOpenTasks(client: SupabaseClient, orgId: string): Promise<Task[]>;
export async function listPatientTasks(client: SupabaseClient, patientId: string): Promise<Task[]>; // todas, qualquer status
export async function listForgotten(client: SupabaseClient, orgId: string): Promise<{ id: string; name: string; phone: string; front: Front; assignedTo: string | null }[]>;
export async function createTask(client: SupabaseClient, i: { orgId: string; patientId: string; front: Front; kind: TaskKind; title: string; ownerId: string; dueAt: Date; sourceMessageId?: string }): Promise<void>;
export async function completeTask(client: SupabaseClient, i: { taskId: string; outcome: string; nextTitle: string; nextDue: string; nextFront: Front | null; closeReason: string }): Promise<void>;
export async function snoozeTask(client: SupabaseClient, i: { taskId: string; orgId: string; dueAt: Date; snoozeCount: number }): Promise<void>;
export const TASK_ERRORS: Record<string, string>; // tarefa_ja_concluida, prazo_invalido, proximo_passo_obrigatorio → frase em português
```

Toda função lança `Error` com mensagem em português quando o Supabase devolve erro. `listOpenTasks` lê `tasks` com `patients(name, phone)` embutido e `status = 'aberta'`.

- [ ] **Step 1: Escrever os testes que falham**

Seguir o molde de `tests/funil-move.test.mjs`: `createClient('http://localhost:54321', 'synthetic-key', { global: { fetch } })` com `fetch` falso que grava as requisições. Testes:

- `listOpenTasks filtra pela organização e só abertas`: a URL contém `org_id=eq.org-a` e `status=eq.aberta`; a linha `{ id:'t1', patient_id:'p1', patients:{ name:'Ana', phone:'5511' }, front:'recepcao', kind:'demanda', title:'x', owner_id:null, due_at:'2026-11-14T18:00:00Z', status:'aberta', draft:null }` vira `{ id:'t1', patientId:'p1', patientName:'Ana', patientPhone:'5511', ownerId:null, dueAt:'2026-11-14T18:00:00Z', ... }`.
- `listOpenTasks não quebra quando o paciente veio nulo`: `patients: null` vira `patientName: ''`.
- `completeTask chama a rpc com os seis parâmetros`: POST em `/rest/v1/rpc/complete_task` com corpo `{ p_task, p_outcome, p_next_title, p_next_due, p_next_front, p_close_reason }`; string vazia vira `null`.
- `completeTask traduz tarefa_ja_concluida`: resposta 400 `{ message: 'tarefa_ja_concluida' }` rejeita com `Outra pessoa já concluiu esta tarefa.`.
- `snoozeTask grava novo prazo e soma o contador`: PATCH com `due_at` e `snooze_count: 3` quando recebe `snoozeCount: 2`, filtrando por `id` e `org_id`.

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --require ./tests/register.cjs --test tests/tasks-data.test.mjs`
Expected: FAIL, módulo não encontrado.

- [ ] **Step 3: Implementar `lib/tasks-data.ts`**

- [ ] **Step 4: Rodar e ver passar**

Run: `node --require ./tests/register.cjs --test tests/tasks-data.test.mjs`
Expected: PASS, 5 testes.

- [ ] **Step 5: Commit**

```bash
git add lib/tasks-data.ts tests/tasks-data.test.mjs
git commit -m "feat(tasks): data access with translated errors"
```

---

### Task 4: Tela "Minha fila"

**Files:**
- Create: `app/(app)/fila/page.tsx` (mesmo molde de `app/(app)/pacientes/page.tsx`)
- Create: `components/fila/fila-client.tsx`
- Create: `components/fila/complete-task-dialog.tsx`
- Create: `components/fila/new-task-dialog.tsx`
- Modify: `lib/org.ts` (`Org` ganha `front: Front | null`, `isManager: boolean`, `userId: string`; `getMyOrg` lê `front, is_manager`)
- Test: `tests/org.test.mjs` (acrescentar caso), `tests/fila-client.test.tsx`

**Interfaces:**
- Consumes: tudo de `lib/tasks.ts` e `lib/tasks-data.ts`; `useOrg()` de `components/org-context.tsx`.
- Produces:
  - `<FilaClient />`.
  - `<CompleteTaskDialog task={Task | null} onClose={() => void} onDone={() => void} />`.
  - `<NewTaskDialog open patientId? onClose onCreated />` — reutilizado nas Tasks 5 e 6.
  - Chave de consulta do react-query `["tasks", orgId]`.

Comportamento:

- Abas: uma por frente de `FRONTS`, mais "Todas". Aba inicial: `org.front`, ou "Todas" se nulo.
- Filtro: `visibleTo` para cada tarefa; gestor tem a chave "Só as minhas" (desligada por padrão).
- Lista por `sortQueue`. Cada linha: nome do paciente, título, selo de urgência (`vencida` vermelho, `hoje` âmbar, `futura` neutro), prazo relativo, e os botões **Abrir conversa** (`/inbox?p={id}`, parâmetro que o Inbox já lê), **Feito**, **Adiar**.
- **Feito** abre `CompleteTaskDialog`: resultado (texto livre), e dois caminhos em abas: "Próxima ação" (título, data e hora, frente) ou "Encerrar paciente" (motivo). `validateCompletion` roda antes do envio e a mensagem aparece junto ao campo.
- **Adiar** pede data e hora; recusa se não for no futuro.
- Gestor vê um bloco "Sem responsável" com as tarefas que `visibleTo` só liberou para ele.
- Seção final "Sem próxima ação ({n})", vinda de `listForgotten`: do próprio usuário (`assignedTo === userId`), ou de todos se gestor. Cada linha tem "Definir próxima ação", que abre `NewTaskDialog` com o paciente preenchido.
- Link discreto no topo: "Orçamentos em aberto e faltas" para `/followup`.
- Estado vazio: "Nada pendente. Nenhum paciente esperando por você."
- Teclado: `j`/`k` movem a seleção, `f` abre Feito, `a` abre Adiar, `Enter` abre a conversa. Ignorados quando o foco está em campo de texto.

- [ ] **Step 1: Escrever os testes que falham**

`tests/org.test.mjs`: novo caso em que a linha de `org_members` traz `front: 'recepcao', is_manager: true` e `getMyOrg` devolve `front: 'recepcao'`, `isManager: true`, `userId` igual ao do usuário autenticado; e um em que `front` vem com valor fora da lista e vira `null`.

`tests/fila-client.test.tsx`, renderizando com `react-dom/server` como `tests/pilot-panel.test.tsx` faz, sobre um componente de apresentação exportado `FilaList({ tasks, now, me, memberIds })`:
- com duas tarefas (uma vencida de outro responsável, uma de hoje minha) e `me` não gestor: o HTML contém o título da minha e não contém o da outra;
- com lista vazia: contém "Nada pendente";
- gestor com tarefa de `ownerId: null`: contém "Sem responsável".

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --require ./tests/register.cjs --test tests/org.test.mjs tests/fila-client.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implementar**

`FilaClient` busca com `useQuery`, assina `postgres_changes` em `crm_tasks` no canal `rt-tasks` e invalida `["tasks", orgId]` a cada evento, do mesmo jeito que o Inbox faz com `rt-inbox`. `FilaList` é só apresentação.

- [ ] **Step 4: Rodar e ver passar**

Run: `node --require ./tests/register.cjs --test tests/org.test.mjs tests/fila-client.test.tsx`
Expected: PASS.

- [ ] **Step 5: Conferir no navegador**

`npm run dev`, abrir `/fila`. Criar uma tarefa, concluir com próxima ação, adiar, encerrar um paciente. Tentar concluir sem próximo passo: a tela recusa. Conferir em 375 px de largura.

- [ ] **Step 6: Commit**

```bash
git add app/\(app\)/fila components/fila lib/org.ts tests/org.test.mjs tests/fila-client.test.tsx
git commit -m "feat(fila): per-front work queue with mandatory next step"
```

---

### Task 5: Inbox — "Virar demanda" e fim do botão de IA

**Files:**
- Modify: `components/inbox/inbox-client.tsx`
- Test: `tests/inbox-demand.test.cjs`

**Interfaces:**
- Consumes: `createTask` de `lib/tasks-data.ts`; `demandDueAt`, `demandTitle` de `lib/tasks.ts`; `org.front`, `org.userId`, `org.settings`.

Comportamento:

- Botão "Virar demanda" no cabeçalho da conversa: cria tarefa `kind: 'demanda'`, `front: org.front ?? 'recepcao'`, `ownerId: org.userId`, título de `demandTitle(última mensagem recebida, nome)`, prazo de `demandDueAt`. Toast: "Demanda criada. Prazo: {hora}."
- A mesma ação em cada mensagem recebida (ícone ao passar o mouse; toque longo no celular), usando o conteúdo daquela mensagem e gravando `sourceMessageId`.
- Remover o botão "IA ativa / Você atendendo" e todo o código que só ele usa: o estado `aiPaused`, a leitura de `chats.ai_service`, a função `toggleAi` e os ícones `Bot`/`User` se ficarem sem uso. A coluna `chats.ai_service` no banco fica como está.

- [ ] **Step 1: Escrever o teste que falha**

`tests/inbox-demand.test.cjs`, no estilo de `tests/inbox-route-effect.test.cjs` (lê o arquivo-fonte e verifica): o fonte de `inbox-client.tsx` não contém `ai_service` nem `aiPaused`, e contém `createTask(` e o texto `Virar demanda`.

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --require ./tests/register.cjs --test tests/inbox-demand.test.cjs`
Expected: FAIL (`ai_service` ainda presente).

- [ ] **Step 3: Implementar**

- [ ] **Step 4: Rodar tudo e ver passar**

Run: `node --require ./tests/register.cjs --test tests/*.test.mjs tests/*.test.ts tests/*.test.tsx tests/*.test.cjs`
Expected: PASS, incluindo os testes antigos do Inbox.

- [ ] **Step 5: Conferir no navegador**

Abrir uma conversa, clicar em "Virar demanda", ver a tarefa em `/fila` com 30 minutos de prazo. Repetir a partir de uma mensagem de áudio: o título é "Demanda de {nome}".

- [ ] **Step 6: Commit**

```bash
git add components/inbox/inbox-client.tsx tests/inbox-demand.test.cjs
git commit -m "feat(inbox): turn a message into a timed demand; drop dead AI toggle"
```

---

### Task 6: Painel do paciente com linha do tempo

**Files:**
- Create: `lib/timeline.ts`
- Create: `components/pacientes/patient-panel.tsx`
- Modify: `components/funil/funil-board.tsx` (troca `PatientFichaDialog` por `PatientPanel`)
- Modify: `components/fila/fila-client.tsx`, `components/pacientes/pacientes-table.tsx`, `components/inbox/inbox-client.tsx` (nome do paciente abre o painel)
- Delete: `components/funil/patient-ficha-dialog.tsx`
- Test: `tests/timeline.test.ts`

**Interfaces:**
- Consumes: `listPatientTasks`; `NewTaskDialog`; `formatCurrency`, `formatPhoneDisplay`, `formatDateBR` de `lib/format.ts`; `CC_BADGE` de `lib/funil.ts`.
- Produces:

```ts
export type TimelineItem = { at: string; kind: "mensagem" | "consulta" | "orcamento" | "tarefa"; title: string; detail: string | null; tone: "neutro" | "bom" | "ruim" };
export function buildTimeline(i: {
  messages: { created_at: string; direction: string; content: string | null; message_type: string | null }[];
  attendances: { appt_date: string; from_time: string | null; status: string; category: string | null }[];
  estimates: { est_date: string; status: string; amount: number | null }[];
  tasks: { dueAt: string; title: string; status: string }[];
}): TimelineItem[];
```

`<PatientPanel patientId={string | null} onClose={() => void} />` busca os próprios dados.

Regras de `buildTimeline`: ordem do mais recente para o mais antigo; consulta `faltou` tem tom `ruim`, `compareceu` tem `bom`; orçamento `APPROVED` é `bom`, `REJECTED` é `ruim`; mensagem sem texto mostra o tipo ("Áudio", "Imagem", "Documento"); data sem hora conta como 12h00 de Brasília.

Painel: cabeçalho fixo com nome, telefone, responsável, frente, **próxima ação e prazo** (a tarefa aberta de prazo mais próximo, ou o aviso em vermelho "Sem próxima ação" com o botão "Definir"), selo do Clinicorp. Abaixo, a linha do tempo. Rodapé: "Abrir conversa", "Editar cadastro" (`/pacientes?editar={id}`), "Nova tarefa". No celular ocupa a tela toda.

Consultas e orçamentos são ligados ao paciente pelo telefone. Usar a mesma regra de casamento que a migração `20261112000000_optimize_get_source_funnel.sql` usa (`phone_canon`); não inventar outra.

- [ ] **Step 1: Escrever os testes que falham**

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { buildTimeline } from "../lib/timeline.ts";

test("mistura as quatro fontes, mais recente primeiro", () => {
  const out = buildTimeline({
    messages: [{ created_at: "2026-11-10T13:00:00Z", direction: "inbound", content: "Oi", message_type: "text" }],
    attendances: [{ appt_date: "2026-11-12", from_time: "09:00", status: "faltou", category: "Avaliação" }],
    estimates: [{ est_date: "2026-11-13", status: "APPROVED", amount: 7500 }],
    tasks: [{ dueAt: "2026-11-11T13:00:00Z", title: "Ligar", status: "feita" }],
  });
  assert.deepEqual(out.map((x) => x.kind), ["orcamento", "consulta", "tarefa", "mensagem"]);
  assert.equal(out[0].tone, "bom");
  assert.equal(out[1].tone, "ruim");
});
test("mensagem sem texto mostra o tipo", () => {
  const out = buildTimeline({ messages: [{ created_at: "2026-11-10T13:00:00Z", direction: "inbound", content: null, message_type: "audio" }], attendances: [], estimates: [], tasks: [] });
  assert.equal(out[0].title, "Áudio");
});
test("tudo vazio devolve lista vazia", () => {
  assert.deepEqual(buildTimeline({ messages: [], attendances: [], estimates: [], tasks: [] }), []);
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --require ./tests/register.cjs --test tests/timeline.test.ts`
Expected: FAIL, módulo não encontrado.

- [ ] **Step 3: Implementar `lib/timeline.ts` e `PatientPanel`; trocar os pontos de uso; apagar `patient-ficha-dialog.tsx`**

- [ ] **Step 4: Rodar tudo e ver passar**

Run: `node --require ./tests/register.cjs --test tests/*.test.mjs tests/*.test.ts tests/*.test.tsx tests/*.test.cjs && npm run lint`
Expected: PASS, lint sem erro, nenhuma importação de `patient-ficha-dialog` sobrando.

- [ ] **Step 5: Conferir no navegador**

Abrir o painel a partir do Funil, da Fila, de Pacientes e do Inbox, com um paciente que tenha consulta e orçamento no Clinicorp. Conferir que os quatro tipos aparecem.

- [ ] **Step 6: Commit**

```bash
git add -A lib/timeline.ts components tests/timeline.test.ts
git commit -m "feat(pacientes): patient panel with unified timeline"
```

---

### Task 7: Navegação de 8 itens

**Files:**
- Modify: `lib/nav.ts`, `components/app-shell.tsx`, `app/page.tsx`
- Create: `app/(app)/gestao/page.tsx`, `components/gestao/gestao-client.tsx`
- Modify: `app/(app)/dashboard/page.tsx`, `app/(app)/metas/page.tsx`, `app/(app)/resultados/page.tsx`, `app/(app)/conexoes/page.tsx` (viram `redirect`)
- Modify: `components/configuracoes/configuracoes-client.tsx` (aba "Conexões" com `<ConexoesClient />`)
- Test: `tests/nav.test.ts`

**Interfaces:**
- Produces: `NAV` com exatamente estes itens, nesta ordem:

| href | label | group |
|---|---|---|
| `/fila` | Minha fila | main |
| `/inbox` | Conversas | main |
| `/pacientes` | Pacientes | main |
| `/agenda` | Agenda | main |
| `/funil` | Funil | main |
| `/automacoes` | Cadências | ops |
| `/gestao` | Gestão | ops |
| `/configuracoes` | Configurações | config |

`navByHref` continua igual. `NavItem` ganha `badge?: "overdue"` e só `/fila` o usa.

Comportamento:

- `/` redireciona para `/fila`.
- `/gestao` tem abas "Visão geral", "Metas", "ROI por origem", lidas de `?aba=`. Como a página do Dashboard é um componente de servidor, o conteúdo dela é extraído para um componente em `components/dashboard/` e usado na primeira aba; as outras duas usam `MetasClient` e `ResultadosClient` como estão.
- `/dashboard` redireciona para `/gestao`; `/metas` para `/gestao?aba=metas`; `/resultados` para `/gestao?aba=roi`; `/conexoes` para `/configuracoes?aba=conexoes`.
- `/followup` continua existindo, fora do menu.
- O item "Minha fila" mostra um contador vermelho com o número de tarefas vencidas visíveis ao usuário (lê `["tasks", orgId]`; nada quando zero).

- [ ] **Step 1: Escrever o teste que falha**

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { NAV, navByHref } from "../lib/nav.ts";

test("menu tem os 8 itens na ordem do design", () => {
  assert.deepEqual(NAV.map((n) => n.href), ["/fila", "/inbox", "/pacientes", "/agenda", "/funil", "/automacoes", "/gestao", "/configuracoes"]);
  assert.deepEqual(NAV.map((n) => n.label), ["Minha fila", "Conversas", "Pacientes", "Agenda", "Funil", "Cadências", "Gestão", "Configurações"]);
});
test("só a fila tem contador", () => {
  assert.deepEqual(NAV.filter((n) => n.badge).map((n) => n.href), ["/fila"]);
});
test("navByHref acha a fila", () => {
  assert.equal(navByHref("/fila")?.label, "Minha fila");
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --require ./tests/register.cjs --test tests/nav.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implementar**

- [ ] **Step 4: Rodar tudo, lint e build**

Run: `node --require ./tests/register.cjs --test tests/*.test.mjs tests/*.test.ts tests/*.test.tsx tests/*.test.cjs && npm run lint && npm run build`
Expected: PASS, build sem erro. Se `tests/app-shell-account.test.cjs` ou `tests/dashboard-auth.test.mjs` dependerem dos rótulos ou da rota antiga, ajustar o teste para a rota nova mantendo o que ele protege (a checagem de autenticação).

- [ ] **Step 5: Conferir no navegador**

Cada rota antiga cai na nova. Menu no celular mostra os 8 itens. O contador da fila aparece com uma tarefa vencida e some quando ela é concluída.

- [ ] **Step 6: Commit**

```bash
git add -A lib/nav.ts components app tests/nav.test.ts
git commit -m "feat(nav): eight-item navigation with the queue as home"
```

---

### Task 8: Equipe — frente, gestor e novo membro

Hoje só existe um usuário no sistema (papel `admin`). Sem contas para a equipe, a fila por pessoa não tem a quem servir.

**Files:**
- Modify: `components/configuracoes/configuracoes-client.tsx` (seção Equipe)
- Create: `supabase/functions/team-invite/index.ts`
- Create: `lib/team.ts`
- Test: `tests/team.test.ts`

**Interfaces:**
- Produces:

```ts
// lib/team.ts
export function validateInvite(i: { email: string; displayName: string; front: string }): string | null;
export async function inviteMember(client: SupabaseClient, i: { email: string; displayName: string; front: Front; isManager: boolean }): Promise<void>; // functions.invoke("team-invite")
export async function updateMember(client: SupabaseClient, i: { memberId: string; orgId: string; front: Front | null; isManager: boolean }): Promise<void>;
```

Edge function `team-invite` (POST, JSON `{ email, display_name, front, is_manager }`):

1. Lê o usuário do cabeçalho `Authorization` com um cliente de chave anônima. Sem usuário: 401.
2. Busca a linha desse usuário em `org_members`. Papel diferente de `admin`: 403. A organização do convite é sempre a dessa linha; nunca vem do corpo.
3. Valida e-mail e `front`. Inválido: 400.
4. Com cliente de `service_role`: `auth.admin.inviteUserByEmail(email)`, depois insere em `org_members` (`role: 'member'`). Se o e-mail já tem conta, usa o usuário existente; se já é membro da organização: 409.
5. CORS igual ao de `supabase/functions/cadence-runner/index.ts`.

Tela: na lista de Equipe, cada membro ganha um seletor de frente e a chave "Gestor". Botão "Adicionar membro" abre e-mail, nome, frente, gestor. Só `org.role === 'admin'` vê os controles.

- [ ] **Step 1: Escrever os testes que falham**

`tests/team.test.ts`:
- `validateInvite({ email: "x", displayName: "Ana", front: "recepcao" })` devolve `"E-mail inválido."`;
- nome vazio devolve `"Informe o nome."`;
- `front: "financeiro"` devolve `"Frente inválida."`;
- entrada válida devolve `null`;
- `inviteMember` com `fetch` falso: POST em `/functions/v1/team-invite` e o corpo **não** contém `org_id`;
- resposta 403 rejeita com `"Só o administrador pode adicionar membros."`.

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --require ./tests/register.cjs --test tests/team.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implementar `lib/team.ts`, a função e a tela**

- [ ] **Step 4: Rodar e ver passar**

Run: `node --require ./tests/register.cjs --test tests/team.test.ts && npm run lint`
Expected: PASS.

- [ ] **Step 5: Pedir o "pode publicar" ao Thiago, publicar a função e testar**

Publicar `team-invite` com verificação de JWT ligada. Chamar sem cabeçalho de autorização: 401. Chamar como admin com um e-mail de teste indicado pelo Thiago: o membro aparece na lista com a frente escolhida.

- [ ] **Step 6: Commit**

```bash
git add lib/team.ts tests/team.test.ts supabase/functions/team-invite components/configuracoes/configuracoes-client.tsx
git commit -m "feat(equipe): fronts, manager flag and admin-only member invite"
```

---

### Task 9: Aviso de prazo estourado

**Files:**
- Create: `components/fila/overdue-watcher.tsx`
- Modify: `components/app-shell.tsx` (monta `<OverdueWatcher />`)
- Modify: `lib/tasks.ts` (acrescenta `newlyOverdue`)
- Test: `tests/tasks.test.ts` (acrescentar)

**Interfaces:**
- Produces: `export function newlyOverdue(tasks: Task[], alreadyWarned: Set<string>, now: Date): Task[]` — tarefas com `dueAt <= now` cujo id não está em `alreadyWarned`.

Comportamento: `OverdueWatcher` lê `["tasks", orgId]`, reavalia a cada 60 segundos e, para cada tarefa recém-vencida visível ao usuário (`visibleTo`), mostra um toast do `sonner` "Prazo estourado: {título} — {paciente}" com a ação "Abrir fila". Cada tarefa avisa uma vez por sessão. O gestor recebe o aviso das tarefas de todos.

- [ ] **Step 1: Escrever o teste que falha**

```ts
test("avisa só o que acabou de vencer e ainda não foi avisado", () => {
  const a = t("a", "2026-11-14T14:00:00-03:00"), b = t("b", "2026-11-14T14:30:00-03:00"), c = t("c", "2026-11-14T16:00:00-03:00");
  assert.deepEqual(newlyOverdue([a, b, c], new Set(["a"]), now).map((x) => x.id), ["b"]);
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --require ./tests/register.cjs --test tests/tasks.test.ts`
Expected: FAIL, `newlyOverdue` não exportado.

- [ ] **Step 3: Implementar**

- [ ] **Step 4: Rodar tudo, lint e build**

Run: `node --require ./tests/register.cjs --test tests/*.test.mjs tests/*.test.ts tests/*.test.tsx tests/*.test.cjs && npm run lint && npm run build`
Expected: PASS.

- [ ] **Step 5: Conferir no navegador**

Criar uma demanda, ajustar o prazo para dois minutos à frente, esperar: o toast aparece uma vez e o contador do menu sobe.

- [ ] **Step 6: Commit**

```bash
git add components/fila/overdue-watcher.tsx components/app-shell.tsx lib/tasks.ts tests/tasks.test.ts
git commit -m "feat(fila): in-app warning when a deadline passes"
```

---

## Fora deste plano

- Cadências genéricas, passagem de bastão, retorno obrigatório, sincronização do Clinicorp a cada 15 minutos e para todos os profissionais: fase 2.
- Saída do Dify, rascunhos, leitura do paciente, "Enviar" pela fila: fase 3.
- Pós-venda, satisfação, depoimentos: fase 4.
- Painel de esquecidos e de prazos por pessoa em Gestão: fase 5.
- Aviso fora do app (WhatsApp ou notificação do navegador) quando o prazo estoura.
