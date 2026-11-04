export type InboxKey = 'reception' | 'commercial' | 'crc';
export const INBOXES: {key: InboxKey; label: string}[] = [
  {key: 'reception', label: 'Recepção'},
  {key: 'commercial', label: 'Comercial'},
  {key: 'crc', label: 'CRC'},
];
type ConversationIdentity = {id: string; patient_id: string; channel_id: string; inbox_key: string | null; name: string; phone: string | null};

export function filterConversations<T extends ConversationIdentity>(rows: T[], sector: InboxKey | 'unassigned', channelId: string, search: string): T[] {
  const query = search.trim().toLocaleLowerCase('pt-BR');
  return rows.filter(row => (sector === 'unassigned' ? !row.inbox_key : row.inbox_key === sector)
    && (channelId === 'all' || row.channel_id === channelId)
    && (!query || row.name.toLocaleLowerCase('pt-BR').includes(query) || (row.phone ?? '').includes(query)));
}

export function conversationFromLink<T extends {id: string; patient_id: string}>(rows: T[], conversationId: string | null, patientId: string | null): string | null {
  if (conversationId) return rows.find(row => row.id === conversationId)?.id ?? null;
  if (!patientId) return null;
  const matches = rows.filter(row => row.patient_id === patientId);
  return matches.length === 1 ? matches[0].id : null;
}

export function mergeConversationMessage<T extends {id: string; conversation_id: string; created_at: string}>(rows: T[], message: T, conversationId: string): T[] {
  if (message.conversation_id !== conversationId || rows.some(row => row.id === message.id)) return rows;
  return [...rows, message].sort((a,b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
}

export function restoreFailedDraft(drafts: Record<string, string>, conversationId: string, text: string): Record<string, string> {
  return drafts[conversationId] ? drafts : {...drafts, [conversationId]: text};
}

export function resolveInboxSelection<T extends ConversationIdentity>(rows: T[], selection: {id: string | null; sector: InboxKey | 'unassigned'; linkKey: string} | null, linkKey: string, conversationId: string | null, patientId: string | null): {id: string | null; sector: InboxKey | 'unassigned'} {
  if (selection?.linkKey === linkKey) return {id: selection.id, sector: selection.sector};
  const id = conversationFromLink(rows, conversationId, patientId);
  const row = rows.find(item => item.id === id);
  const sector = !row ? 'reception' : INBOXES.some(item => item.key === row.inbox_key) ? row.inbox_key as InboxKey : 'unassigned';
  return {id, sector};
}
