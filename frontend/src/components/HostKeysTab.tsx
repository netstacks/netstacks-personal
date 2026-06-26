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
  type TrustedHostKey,
} from '../api/hostKeys'
import { confirmDialog } from './ConfirmDialog'
import { showToast } from './Toast'
import { useSubmitting } from '../hooks/useSubmitting'
import './HostKeysTab.css'

import { getErrorMessage } from '../api/errors'
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

  const filtered = filter.trim()
    ? keys.filter((k) =>
        `${k.host}:${k.port} ${k.key_type} ${k.fingerprint}`
          .toLowerCase()
          .includes(filter.trim().toLowerCase()),
      )
    : keys

  return (
    <div className="host-keys-tab settings-content">
      <div className="settings-section">
        <div className="host-keys-header">
          <div>
            <h3>Trusted SSH Host Keys</h3>
            <p className="settings-section-description">
              Every host:port you've trusted via the TOFU prompt. Revoke
              an entry to be re-prompted on the next connection — useful
              after an unintended trust click or a legitimate device
              re-key.
            </p>
          </div>
          <button
            className="btn-secondary"
            onClick={load}
            disabled={loading || submitting}
            title="Reload trusted host keys"
          >
            {loading ? 'Loading…' : 'Refresh'}
          </button>
        </div>

        {error && <div className="settings-error">{error}</div>}

        {!loading && keys.length === 0 && !error && (
          <div className="host-keys-empty">
            <p>No trusted host keys yet.</p>
            <p className="settings-note">
              The first time you SSH to a new host you'll be prompted to
              verify and accept its fingerprint. Accepted entries appear
              here for later audit and revocation.
            </p>
          </div>
        )}

        {keys.length > 0 && (
          <>
            <div className="host-keys-filter">
              <input
                type="search"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter by host, port, key type, or fingerprint…"
              />
              {filter && (
                <button
                  className="host-keys-filter-clear"
                  onClick={() => setFilter('')}
                  title="Clear filter"
                >
                  ×
                </button>
              )}
            </div>

            <div className="host-keys-list">
              {filtered.length === 0 ? (
                <div className="host-keys-empty">
                  <p>No matches for "{filter}".</p>
                </div>
              ) : (
                filtered.map((entry) => (
                  <div
                    key={`${entry.host}:${entry.port}`}
                    className="host-keys-item"
                  >
                    <div className="host-keys-item-info">
                      <div className="host-keys-item-host">
                        <strong>{entry.host}</strong>
                        <span className="host-keys-item-port">:{entry.port}</span>
                        <span className="host-keys-item-type">{entry.key_type}</span>
                      </div>
                      <div className="host-keys-item-fp" title={entry.fingerprint}>
                        {entry.fingerprint}
                      </div>
                    </div>
                    <button
                      className="btn-danger host-keys-item-revoke"
                      onClick={() => handleRevoke(entry)}
                      disabled={submitting}
                      title="Revoke trust — next connection will re-prompt"
                    >
                      Revoke
                    </button>
                  </div>
                ))
              )}
            </div>

            <p className="settings-note">
              Showing {filtered.length} of {keys.length} trusted{' '}
              {keys.length === 1 ? 'host' : 'hosts'}.
            </p>
          </>
        )}
      </div>
    </div>
  )
}
