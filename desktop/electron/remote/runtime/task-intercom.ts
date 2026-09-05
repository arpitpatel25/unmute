import { startMcpServer, MCP_PATH, type McpServer } from '../mcp-server'

/** Task bearer identities belong to the same runtime as the provider. */
export class RuntimeTaskIntercom {
  private identities = new Map<string, string>()
  private server?: McpServer
  private starting?: Promise<McpServer>
  constructor(private host: (method: string, args: unknown[]) => Promise<any>) {}
  async register(taskId: string, token: string): Promise<string> {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(taskId) || typeof token !== 'string' || token.length < 20) throw new Error('Invalid task credentials')
    this.identities.set(token, taskId)
    const server = await (this.starting ??= startMcpServer({
      resolveCaller: token => token && this.identities.has(token) ? { kind: 'task', taskId: this.identities.get(token)! } : null,
      createTask: (id, input) => this.host('task.create', [id, input]),
      taskStatus: (id, child) => this.host('task.status', [id, child]),
      setStatus: (id, input) => this.host('task.setStatus', [id, input]),
    }, 0).then(server => { this.server = server; return server }).catch(error => { this.starting = undefined; throw error }))
    return `http://127.0.0.1:${server.port}${MCP_PATH}`
  }
  close(): void { this.server?.close() }
}
