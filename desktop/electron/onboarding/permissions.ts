export type MicrophonePermission = 'unknown' | 'not-determined' | 'granted' | 'denied' | 'restricted'
export type SystemAudioPermission = 'unknown' | 'granted' | 'denied' | 'restart-required'
export type PermissionKind = 'microphone' | 'accessibility' | 'system-audio'

export interface PermissionSnapshot {
  microphone: MicrophonePermission
  accessibility: boolean
  systemAudio: SystemAudioPermission
}

export interface SystemAudioTapAdapter {
  start(): void | Promise<void>
  stop(): void | Promise<void>
  status(): SystemAudioPermission | Promise<SystemAudioPermission>
}

export interface PermissionAdapters {
  microphoneStatus(): MicrophonePermission | Promise<MicrophonePermission>
  requestMicrophone(): MicrophonePermission | Promise<MicrophonePermission>
  accessibilityStatus(): boolean | Promise<boolean>
  requestAccessibility(): void | Promise<void>
  systemAudio: SystemAudioTapAdapter
}

export async function preflightSystemAudio(tap: SystemAudioTapAdapter): Promise<SystemAudioPermission> {
  try {
    await tap.start()
  } catch {
    // TCC denial is reported by the adapter's status after the attempted tap.
  } finally {
    try { await tap.stop() } catch { /* the tap may never have become active */ }
  }
  return tap.status()
}

export async function probePermissions(adapters: PermissionAdapters): Promise<PermissionSnapshot> {
  const [microphone, accessibility, systemAudio] = await Promise.all([
    adapters.microphoneStatus(),
    adapters.accessibilityStatus(),
    adapters.systemAudio.status(),
  ])
  return { microphone, accessibility, systemAudio }
}

export async function requestPermission(
  kind: PermissionKind,
  adapters: PermissionAdapters,
): Promise<PermissionSnapshot> {
  switch (kind) {
    case 'microphone': await adapters.requestMicrophone(); break
    case 'accessibility': await adapters.requestAccessibility(); break
    case 'system-audio': await preflightSystemAudio(adapters.systemAudio); break
  }
  return probePermissions(adapters)
}

export async function checkpointAndRelaunch(
  checkpoint: () => Promise<void>,
  app: { relaunch(): void; exit(code: number): void },
): Promise<void> {
  await checkpoint()
  app.relaunch()
  app.exit(0)
}
