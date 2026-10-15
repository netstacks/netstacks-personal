// Trusted SSH host keys (TOFU) — list + revoke.
//
// SSH host-key Trust-On-First-Use is one-way at connect time: the user
// either accepts the fingerprint and the key gets persisted to
// known_hosts, or they reject and the connection aborts. Once trusted,
// a key sticks forever — even if it was trusted by mistake.
//
// This tab gives the user a way back: list every trusted entry and
// revoke individual ones, which causes the next connection to that
// host:port to trigger a fresh TOFU prompt.

import { useCallback, useEffect, useState } from 'react'
import {
  listTrustedHostKeys,
  deleteTrustedHostKey,
  purgeTrustedHostKeys,
  type TrustedHostKey,
} from '../api/hostKeys'
import { confirmDialog } from './ConfirmDialog'
import { showToast } from './Toast'
import { useSubmitting } from '../hooks/useSubmitting'
import SearchField from './SearchField'
import SettingsSection from './settings/SettingsSection'
import SettingsItem from './settings/SettingsItem'

import { getErrorMessage } from '../api/errors'
import Tooltip from './Tooltip'
export default function HostKeysTab() {
  const [keys, setKeys] = useState<TrustedHostKey[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const { submitting, run } = useSubmitting()

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await listTrustedHostKeys()
      setKeys(data)
    } catch (err) {
      const message = getErrorMessage(err, 'Failed to load trusted host keys')
      setError(message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const handleRevoke = async (entry: TrustedHostKey) => {
    const ok = await confirmDialog({
      title: 'Revoke trusted host key?',
      body: (
        <>
          Remove the trusted key for{' '}
          <strong>
            {entry.host}:{entry.port}
          </strong>
          ? The next connection will prompt you to verify and trust a new
          fingerprint. Use this if you accepted a key by mistake or the
          host has been legitimately re-keyed (firmware upgrade, RMA).
        </>
      ),
      confirmLabel: 'Revoke',
      destructive: true,
    })
    if (!ok) return

    await run(async () => {
      try {
        await deleteTrustedHostKey(entry.host, entry.port)
        setKeys((prev) =>
          prev.filter((k) => !(k.host === entry.host && k.port === entry.port)),
        )
        showToast(`Revoked trusted key for ${entry.host}:${entry.port}`, 'success')
      } catch (err) {
        const message = getErrorMessage(err, 'Failed to revoke host key')
        showToast(message, 'error')
      }
    })
  }

  const handlePurgeAll = async () => {
    const ok = await confirmDialog({
      title: 'Purge ALL trusted host keys?',
      body: (
        <>
          Remove <strong>all {keys.length}</strong> trusted host key
          {keys.length === 1 ? '' : 's'}? Every host will prompt you to verify a
          fresh fingerprint on the next connection. Use this only to reset all
          TOFU trust — e.g. after a large-scale re-key or to clear a store you no
          longer trust.
        </>
      ),
      confirmLabel: 'Purge all',
      destructive: true,
    })
    if (!ok) return

    await run(async () => {
      try {
        const removed = await purgeTrustedHostKeys()
        setKeys([])
        showToast(`Purged ${removed} trusted host key${removed === 1 ? '' : 's'}`, 'success')
      } catch (err) {
        showToast(getErrorMessage(err, 'Failed to purge host keys'), 'error')
      }
    })
  }

  const filtered = filter.trim()
    ? keys.filter((k) =>
        `${k.host}:${k.port} ${k.key_type} ${k.fingerprint}`
          .toLowerCase()
          .includes(filter.trim().toLowerCase()),
      )
    : keys

  return (
    <SettingsSection
      title="Trusted SSH Host Keys"
      description="Every host:port you've trusted via the first-connection prompt. Revoke an entry to be re-prompted on the next connection — useful after an unintended trust click or a legitimate device re-key."
      actions={
        <>
          <Tooltip label="Reload trusted host keys"><button
            className="ns-btn ns-btn--small ns-btn--ghost"
            onClick={load}
            disabled={loading || submitting}
          >
            {loading ? 'Loading…' : 'Refresh'}
          </button></Tooltip>
          {keys.length > 0 && (
            <Tooltip label="Remove all trusted host keys"><button
              className="ns-btn ns-btn--small ns-btn--danger"
              onClick={handlePurgeAll}
              disabled={loading || submitting}
            >
              Purge All
            </button></Tooltip>
          )}
        </>
      }
    >
      {error && <p className="settings-error">{error}</p>}

      {!loading && keys.length === 0 && !error && (
        <p className="form-hint">
          No trusted host keys yet. The first time you SSH to a new host you'll be prompted to verify and accept its
          fingerprint; accepted entries appear here for later audit and revocation.
        </p>
      )}

      {keys.length > 0 && (
        <>
          <SearchField
            value={filter}
            onChange={setFilter}
            placeholder="Filter by host, port, key type, or fingerprint…"
          />
          {filtered.length === 0 ? (
            <p className="form-hint">No matches for "{filter}".</p>
          ) : (
            <div className="settings-group">
              {filtered.map((entry) => (
                <SettingsItem
                  key={`${entry.host}:${entry.port}`}
                  title={`${entry.host}:${entry.port}`}
                  badges={<span className="settings-badge">{entry.key_type}</span>}
                  meta={<code title={entry.fingerprint}>{entry.fingerprint}</code>}
                  actions={
                    <Tooltip label="Revoke trust — next connection will re-prompt"><button
                      className="ns-btn ns-btn--small ns-btn--ghost ns-btn--danger"
                      onClick={() => handleRevoke(entry)}
                      disabled={submitting}
                    >
                      Revoke
                    </button></Tooltip>
                  }
                />
              ))}
            </div>
          )}
          <p className="form-hint">
            Showing {filtered.length} of {keys.length} trusted{' '}
            {keys.length === 1 ? 'host' : 'hosts'}.
          </p>
        </>
      )}
    </SettingsSection>
  )
}
