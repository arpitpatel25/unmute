import { DriverManager } from '../cua/driver-manager'
import { startCuaServer, type CuaServer } from '../cua/server'
import { Arming } from '../cua/lanes/arming'
import { CdpLane } from '../cua/lanes/cdp'
import { runAppleScript } from '../cua/lanes/applescript'
import { normalizePolicy, type AxPolicy } from '../ax/policy'

/** Computer tools retain their server and driver pool across UI disconnects. */
export class ComputerRuntimeService {
  private policy: AxPolicy = normalizePolicy({})
  private manager?: DriverManager
  private server?: CuaServer
  private starting?: Promise<number>
  private arming = new Arming()
  constructor(private emit: (event: unknown) => void) {}
  configure(input: { binPath: string; policy: AxPolicy; port?: number }): Promise<number> {
    this.policy = normalizePolicy(input.policy)
    return this.starting ??= this.start(input).catch(error => { this.starting = undefined; throw error })
  }
  private async start(input: { binPath: string; port?: number }): Promise<number> {
    this.manager = new DriverManager({ binPath: input.binPath, hostBundleId: 'unmute', getEnabled: () => this.policy.enabled })
    this.server = await startCuaServer({ manager: this.manager, port: input.port ?? 0,
      getPolicy: () => this.policy, onActivity: event => this.emit(event),
      router: { cdp: new CdpLane(app => this.arming.portFor(app)), arming: this.arming, runAppleScript, getPolicy: () => this.policy },
    })
    return this.server.port
  }
  close(): void { this.server?.close(); this.manager?.dispose(); void this.arming.disposeAll() }
}
