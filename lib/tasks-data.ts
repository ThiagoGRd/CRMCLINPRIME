import type { SupabaseClient } from '@supabase/supabase-js';
import type { Front, Task, TaskKind } from './tasks';

export const TASK_ERRORS: Record<string, string> = {
  tarefa_ja_concluida: 'Outra pessoa já concluiu esta tarefa.',
  prazo_invalido: 'O prazo da próxima ação precisa ser no futuro.',
  proximo_passo_obrigatorio: 'Informe a próxima ação ou encerre o paciente com um motivo.',
  paciente_nao_encerrado: 'Não foi possível encerrar o paciente.',
};

function fail(error: { message?: string } | null): void {
  if (!error) return;
  const key = Object.keys(TASK_ERRORS).find((k) => error.message?.includes(k));
  throw new Error(key ? TASK_ERRORS[key] : 'Não foi possível salvar. Tente de novo.');
}

type TaskRow = {
  id: string; patient_id: string; patients: { name: string; phone: string } | null;
  front: Front; kind: TaskKind; title: string; owner_id: string | null;
  due_at: string; status: Task['status']; draft: string | null;
};

const toTask = (r: TaskRow): Task => ({
  id: r.id, patientId: r.patient_id, patientName: r.patients?.name ?? '', patientPhone: r.patients?.phone ?? '',
  front: r.front, kind: r.kind, title: r.title, ownerId: r.owner_id, dueAt: r.due_at, status: r.status, draft: r.draft,
});

const SELECT = 'id, patient_id, front, kind, title, owner_id, due_at, status, draft, patients(name, phone)';

export async function listOpenTasks(client: SupabaseClient, orgId: string): Promise<Task[]> {
  const { data, error } = await client.from('tasks').select(SELECT).eq('org_id', orgId).eq('status', 'aberta');
  fail(error);
  return ((data ?? []) as unknown as TaskRow[]).map(toTask);
}

export async function listPatientTasks(client: SupabaseClient, patientId: string): Promise<Task[]> {
  const { data, error } = await client.from('tasks').select(SELECT).eq('patient_id', patientId).order('due_at', { ascending: false });
  fail(error);
  return ((data ?? []) as unknown as TaskRow[]).map(toTask);
}

export const FORGOTTEN_LIMIT = 100;

export async function listForgotten(
  client: SupabaseClient, orgId: string,
): Promise<{ rows: { id: string; name: string; phone: string; front: Front; assignedTo: string | null }[]; total: number }> {
  const { data, error, count } = await client.from('crm_forgotten_patients')
    .select('id, name, phone, front, assigned_to', { count: 'exact' }).eq('org_id', orgId)
    .order('last_message_at', { ascending: false, nullsFirst: false }).limit(FORGOTTEN_LIMIT);
  fail(error);
  const rows = (data ?? []).map((r) => ({ id: r.id, name: r.name, phone: r.phone, front: r.front, assignedTo: r.assigned_to }));
  return { rows, total: count ?? rows.length };
}

export async function createTask(client: SupabaseClient, i: {
  orgId: string; patientId: string; front: Front; kind: TaskKind; title: string; ownerId: string; dueAt: Date; sourceMessageId?: string;
}): Promise<void> {
  const { error } = await client.from('tasks').insert({
    kind: i.kind, front: i.front, title: i.title, owner_id: i.ownerId, due_at: i.dueAt.toISOString(),
    org_id: i.orgId, patient_id: i.patientId,
    ...(i.sourceMessageId ? { source_message_id: i.sourceMessageId } : {}),
  });
  fail(error);
}

export async function completeTask(client: SupabaseClient, i: {
  taskId: string; outcome: string; nextTitle: string; nextDue: string; nextFront: Front | null; closeReason: string;
}): Promise<void> {
  const { error } = await client.rpc('complete_task', {
    p_task: i.taskId, p_outcome: i.outcome, p_next_title: i.nextTitle || null, p_next_due: i.nextDue || null,
    p_next_front: i.nextFront, p_close_reason: i.closeReason || null,
  });
  fail(error);
}

export async function snoozeTask(client: SupabaseClient, i: {
  taskId: string; orgId: string; dueAt: Date; snoozeCount: number;
}): Promise<void> {
  const { data, error } = await client.from('tasks')
    .update({ due_at: i.dueAt.toISOString(), snooze_count: i.snoozeCount + 1 })
    .eq('id', i.taskId).eq('org_id', i.orgId).eq('status', 'aberta')
    .select('id');
  fail(error);
  if (!data?.length) throw new Error(TASK_ERRORS.tarefa_ja_concluida);
}
