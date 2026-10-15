import { confirmDialog } from '../components/ConfirmDialog'

export function installTestHooks(): void {
  window.__ns = {
    confirm: () => confirmDialog({
      title: 'Delete session?',
      body: 'core-rtr-01 will be removed from your saved sessions.',
      confirmLabel: 'Delete',
      destructive: true,
    }),
  }
}
