export type PendingStatus = 'open' | 'in_progress' | 'resolved';
export type PendingFilter = 'active' | 'resolved';
export type PendingDraft = { title: string; description: string; assigned_to: string; due_at: string; status: string };
export type PendingItem = {
  id: string; org_id: string; patient_id: string; conversation_id: string;
  title: string; description: string | null; assigned_to: string; due_at: string;
  status: PendingStatus; resolution_evidence: string | null; resolved_by: string | null;
  resolved_at: string | null; created_at: string; updated_at: string;
};

export function buildPendingUpdate(draft: Pick<PendingDraft, 'assigned_to' | 'due_at' | 'status'>, memberIds: string[]) {
  if (!draft.assigned_to || !memberIds.includes(draft.assigned_to)) throw new Error('Selecione um responsável da organização.');
  if (!draft.due_at || !Number.isFinite(Date.parse(draft.due_at))) throw new Error('Informe um prazo válido.');
  if (draft.status !== 'open' && draft.status !== 'in_progress') throw new Error('Para resolver, use a ação explícita e registre a evidência.');
  return { assigned_to: draft.assigned_to, due_at: new Date(draft.due_at).toISOString(), status: draft.status };
}

export function buildPendingCreate(orgId: string, patientId: string, conversationId: string, draft: PendingDraft, memberIds: string[]) {
  if (!orgId || !patientId || !conversationId) throw new Error('Selecione uma conversa e um paciente da organização.');
  if (!draft.title.trim()) throw new Error('Informe o título da pendência.');
  if (draft.title.trim().length > 200) throw new Error('O título deve ter no máximo 200 caracteres.');
  return { org_id: orgId, patient_id: patientId, conversation_id: conversationId, title: draft.title.trim(), description: draft.description.trim(), ...buildPendingUpdate(draft, memberIds) };
}

export function buildPendingResolution(id: string, evidence: string) {
  if (!id || !evidence.trim()) throw new Error('Descreva a evidência antes de resolver a pendência.');
  return { p_id: id, p_evidence: evidence.trim() };
}

export function pendingListScope(orgId: string, patientId: string | null = null, conversationId: string | null = null, filter: PendingFilter = 'active', page = 0) {
  return { queryKey: ['pending-items', orgId, patientId, conversationId, filter, page], orgId, patientId, conversationId, statuses: filter === 'resolved' ? ['resolved'] : ['open', 'in_progress'], from: page * 50, to: page * 50 + 49 };
}
