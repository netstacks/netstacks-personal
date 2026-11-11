import { useEffect } from 'react'

/** Fired (window-level) after any API resource or saved request is
 *  created, updated or deleted, so the sidebar tree and open request tabs
 *  refetch without prop drilling. */
export const API_CLIENT_CHANGED_EVENT = 'netstacks:api-resources-changed'

/** Fired when the user should be taken to the API section of the
 *  Workspaces sidebar (Settings deep links, command palette). */
export const API_CLIENT_REVEAL_EVENT = 'netstacks:api-client-reveal'

export function notifyApiClientChanged(): void {
  window.dispatchEvent(new Event(API_CLIENT_CHANGED_EVENT))
}

export function revealApiClient(): void {
  window.dispatchEvent(new Event(API_CLIENT_REVEAL_EVENT))
}

/** Run `onChange` every time the API client data changes elsewhere. */
export function useApiClientChanged(onChange: () => void): void {
  useEffect(() => {
    window.addEventListener(API_CLIENT_CHANGED_EVENT, onChange)
    return () => window.removeEventListener(API_CLIENT_CHANGED_EVENT, onChange)
  }, [onChange])
}
