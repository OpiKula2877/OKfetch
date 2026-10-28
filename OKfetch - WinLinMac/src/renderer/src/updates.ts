// The app's own update as the Settings page and the start-up toast show it. The Windows main process and the Android
// app download the newest release in the background and report the state here; installing waits for the user.
import { useEffect, useState } from 'react'
import type { UpdateState } from '../../shared/ipc'
import { api } from './api'

/** The state of the app's own update; null where the build has none (the browser UI tests). */
export function useUpdateState(): UpdateState | null {
  const [state, setState] = useState<UpdateState | null>(null)
  useEffect(() => {
    if (!api.updateState) return
    void api.updateState().then(setState)
    return api.onEvent((event) => {
      if (event.type === 'update') setState(event.state)
    })
  }, [])
  return state
}

/** Looks for a newer release now; the answer comes back as an update event. */
export function checkForUpdate(): void {
  void api.checkForUpdate?.()
}

/** Installs the downloaded release. False when Android still has to allow installs from OKfetch. */
export function installUpdate(): Promise<boolean> {
  return api.installUpdate?.() ?? Promise.resolve(false)
}
