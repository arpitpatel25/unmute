export interface AgentTaskReceipt { source: 'unmute-agent'; taskId: string; href: `unmute://task/${string}`; cwd: string }
export function validAgentTaskReceipt(value: unknown, workspace: string): value is AgentTaskReceipt {
  if (!value || typeof value !== 'object') return false
  const receipt = value as Partial<AgentTaskReceipt>
  return receipt.source === 'unmute-agent' && typeof receipt.taskId === 'string'
    && receipt.href === `unmute://task/${receipt.taskId}` && receipt.cwd === workspace
}
