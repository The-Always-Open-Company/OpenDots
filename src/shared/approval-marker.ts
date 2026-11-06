/**
 * A chat message that marks where an approval request belongs in the
 * conversation. The chat draws it as the approval card; the model never sees
 * it, since the outcome reaches the model in its own turn.
 */
export const approvalMarkerPrefix = 'opendots-approval:';

export function approvalMarkerId(message: {
  id: string;
  role: string;
  metadata?: unknown;
}): string | null {
  if (message.role !== 'user' || !message.id.startsWith(approvalMarkerPrefix))
    return null;
  const metadata =
    message.metadata && typeof message.metadata === 'object'
      ? (message.metadata as { actionId?: unknown })
      : undefined;
  return typeof metadata?.actionId === 'string' ? metadata.actionId : null;
}

export function isApprovalMarker(message: {
  id: string;
  role: string;
}): boolean {
  return message.role === 'user' && message.id.startsWith(approvalMarkerPrefix);
}
