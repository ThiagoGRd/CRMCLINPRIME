import type { SupabaseClient } from '@supabase/supabase-js';
import type { Lead } from './funil.ts';

type MoveOptions = {
  client: Pick<SupabaseClient, 'from'>;
  orgId: string;
  lead: Lead;
  targetStageId: string;
  pendingMoves: Set<string>;
  setLeads: (update: (current: Lead[]) => Lead[]) => void;
};

type MoveResult = { status: 'moved' | 'failed' | 'pending' };

export async function moveLeadStage({
  client, orgId, lead, targetStageId, pendingMoves, setLeads,
}: MoveOptions): Promise<MoveResult> {
  // Serialize writes for this patient, including the first deal insertion.
  if (pendingMoves.has(lead.id)) return { status: 'pending' };
  pendingMoves.add(lead.id);
  setLeads((current) => current.map((item) => item.id === lead.id ? { ...item, stageId: targetStageId } : item));

  try {
    const movedAt = new Date().toISOString();
    const { data, error } = lead.dealId
      ? await client.from('deals')
        .update({ stage_id: targetStageId, moved_at: movedAt })
        .eq('id', lead.dealId).eq('org_id', orgId).select('id').single()
      : await client.from('deals')
        .insert({ patient_id: lead.id, stage_id: targetStageId, org_id: orgId, position: 0, moved_at: movedAt })
        .select('id').single();

    // Supabase normally returns an error rather than throwing. Require a row
    // as well so an update blocked by RLS cannot appear successful.
    if (error || !data || typeof data.id !== 'string' || !data.id) {
      throw error ?? new Error('The server did not confirm the moved deal');
    }
    if (!lead.dealId) {
      setLeads((current) => current.map((item) => item.id === lead.id ? { ...item, dealId: data.id } : item));
    }
    return { status: 'moved' };
  } catch {
    // Undo only this optimistic stage, not another lead or a newer local edit.
    setLeads((current) => current.map((item) => item.id === lead.id && item.stageId === targetStageId
      ? { ...item, stageId: lead.stageId } : item));
    return { status: 'failed' };
  } finally {
    pendingMoves.delete(lead.id);
  }
}
