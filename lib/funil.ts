export type Stage = {
  id: string;
  name: string;
  position: number;
  color: string | null;
};

export type Lead = {
  id: string;
  name: string;
  phone: string; // cru (com 55)
  source: string;
  channel: string | null;
  notes: string | null;
  tags: string[];
  createdAt: string | null;
  stageId: string | null;
  dealId: string | null;
  ccStatus: string | null; // APPROVED | OPEN | FOLLOWUP | REJECTED
  ccAmount: number;
  ccCount: number;
};

// Badge do status real no Clinicorp
export const CC_BADGE: Record<string, { label: string; color: string; bg: string }> = {
  APPROVED: { label: "✓ Orçamento aprovado", color: "#10b981", bg: "rgba(16,185,129,.15)" },
  FOLLOWUP: { label: "↻ Orçamento em follow-up", color: "#f59e0b", bg: "rgba(245,158,11,.15)" },
  OPEN: { label: "• Orçamento em aberto", color: "#3b82f6", bg: "rgba(59,130,246,.15)" },
  REJECTED: { label: "✕ Orçamento reprovado", color: "#94a3b8", bg: "rgba(148,163,184,.15)" },
};

// Ponto colorido de fallback por índice (quando a etapa não tem cor)
export const STAGE_FALLBACK_COLORS = ["#a29bfe", "#74b9ff", "#ffeaa7", "#fd79a8", "#f59e0b", "#10b981", "#8b5cf6"];
