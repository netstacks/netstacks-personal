// Types for the API client (sidebar tree + request tab)

import type { QuickAction } from './quickAction'

/** How the request body is sent. Only sets the Content-Type header — the
 *  agent sends the body verbatim either way. */
export type ApiRequestBodyMode = 'json' | 'text' | 'form'

/** Editable request state held by an API request tab. */
export interface ApiRequestDraft {
  method: string
  path: string
  /** Header map as JSON text (kept as text so the editor can hold partial input). */
  headersJson: string
  body: string
  bodyMode: ApiRequestBodyMode
  jsonExtractPath: string
}

/** What App passes when opening an API request tab. */
export interface ApiRequestTabInit {
  /** Resource to send against. Omitted = first available (blank request from the command palette). */
  resourceId?: string
  /** Saved request being edited; omitted = unsaved draft. */
  action?: QuickAction
}
