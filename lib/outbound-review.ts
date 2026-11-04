export type OutboundReviewOperation = 'finalize' | 'cancel' | 'observe';
export function buildOutboundReview(requestId: string, conversationId: string, operation: string, evidence: string) {
  const trimmed=evidence.trim();
  if (!requestId || !conversationId || !['finalize','cancel','observe'].includes(operation) || !trimmed || trimmed.length > 2000) {
    throw new Error('Escolha a tentativa, uma ação válida e descreva a evidência em até 2.000 caracteres.');
  }
  return {action:'reconcile' as const,request_id:requestId,conversation_id:conversationId,operation:operation as OutboundReviewOperation,evidence:trimmed};
}
