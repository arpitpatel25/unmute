// The React side of detectedAgents.ts — kept apart so the pure rules there can
// be tested without a DOM or React.

import { useEffect, useState } from 'react'
import { vendorsOf, type Vendor } from './detectedAgents'

type API = {
  remoteAgentOptions?: () => Promise<{ options: Array<{ id: string }> } | null | undefined>
}

export function useDetectedVendors(): Vendor[] {
  const [vendors, setVendors] = useState<Vendor[]>([])
  useEffect(() => {
    let cancelled = false
    const api = (window as unknown as { electronAPI?: API }).electronAPI
    void api?.remoteAgentOptions?.()
      .then((picker) => { if (!cancelled && picker) setVendors(vendorsOf(picker.options.map((o) => o.id))) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])
  return vendors
}
