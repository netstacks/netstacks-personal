import { useState, useCallback, useRef, useEffect } from 'react'
import { getClient } from '../../api/client'
import { getSidecarAuthToken } from '../../api/localClient'

import { getErrorMessage } from '../../api/errors'
interface WorkspaceOutputPanelProps {
  filePath: string | null
  onClose: () => void
}

interface RunOutput {
  stdout: string
  stderr: string
  exit_code: number
  duration_ms: number
}

export default function WorkspaceOutputPanel({ filePath }: WorkspaceOutputPanelProps) {
  const [running, setRunning] = useState(false)
  const [output, setOutput] = useState<RunOutput | null>(null)
  const [streamStatus, setStreamStatus] = useState<string | null>(null)
  const [streamStdout, setStreamStdout] = useState<string[]>([])
  const [streamStderr, setStreamStderr] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const outputRef = useRef<HTMLDivElement>(null)
  const abortRef = useRef<AbortController | null>(null)

  const autoScroll = useCallback(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight
    }
  }, [])

  useEffect(() => {
    autoScroll()
  }, [streamStdout.length, streamStderr.length, autoScroll])

  const run = useCallback(async () => {
    if (!filePath || running) return

    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller

    setRunning(true)
    setOutput(null)
    setError(null)
    setStreamStatus(null)
    setStreamStdout([])
    setStreamStderr([])

    try {
      const baseUrl = getClient().http.defaults.baseURL || ''
      const token = getSidecarAuthToken() || ''
      const url = `${baseUrl}/local/run-python`

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ path: filePath }),
        signal: controller.signal,
      })

      if (!response.ok) {
        const errData = await response.json().catch(() => ({ error: response.statusText }))
        throw new Error(errData.error || response.statusText)
      }

      const reader = response.body?.getReader()
      if (!reader) throw new Error('No response stream')

      const decoder = new TextDecoder()
      let buffer = ''
      const collectedStdout: string[] = []
      const collectedStderr: string[] = []
      let finalExitCode = -1
      let finalDuration = 0

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          if (line.startsWith('event: ')) {
            const eventType = line.slice(7).trim()
            const dataIdx = lines.indexOf(line) + 1
            if (dataIdx < lines.length && lines[dataIdx].startsWith('data: ')) {
              // handled below
            }
            void eventType
          } else if (line.startsWith('data: ')) {
            const data = line.slice(6)
            const prevLine = lines[lines.indexOf(line) - 1] || ''
            const eventType = prevLine.startsWith('event: ') ? prevLine.slice(7).trim() : ''

            switch (eventType) {
              case 'status':
                setStreamStatus(data)
                break
              case 'stderr':
                collectedStderr.push(data)
                setStreamStderr(prev => [...prev, data])
                break
              case 'stdout':
                collectedStdout.push(data)
                setStreamStdout(prev => [...prev, data])
                break
              case 'complete':
                try {
                  const parsed = JSON.parse(data)
                  finalExitCode = parsed.exit_code
                  finalDuration = parsed.duration_ms
                } catch { /* malformed complete-event payload — ignore */ }
                break
              case 'error':
                setError(data)
                break
            }
          }
        }
      }

      setStreamStatus(null)
      setOutput({
        stdout: collectedStdout.join('\n'),
        stderr: collectedStderr.join('\n'),
        exit_code: finalExitCode,
        duration_ms: finalDuration,
      })
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        setError(getErrorMessage(err, 'Failed to run script'))
      }
    } finally {
      setRunning(false)
      setStreamStatus(null)
    }
  }, [filePath, running])

  // Auto-run on mount when filePath changes
  useEffect(() => {
    if (filePath) {
      run()
    }
    return () => { abortRef.current?.abort() }
  }, [filePath])

  const handleStop = useCallback(() => {
    abortRef.current?.abort()
  }, [])

  const handleClear = useCallback(() => {
    setOutput(null)
    setStreamStdout([])
    setStreamStderr([])
    setError(null)
    setStreamStatus(null)
  }, [])

  const fileName = filePath?.split('/').pop() || 'script'
  const isStreaming = running && (streamStatus || streamStdout.length > 0 || streamStderr.length > 0)

  return (
    <div className="workspace-output-panel">
      <div className="workspace-output-header">
        <span className="workspace-output-title">Output</span>
        {output && !running && (
          <span className={`workspace-output-exit ${output.exit_code === 0 ? 'success' : 'error'}`}>
            exit {output.exit_code} in {output.duration_ms}ms
          </span>
        )}
        <div className="workspace-output-actions">
          {running && (
            <button className="workspace-terminal-action-btn" onClick={handleStop} title="Stop">
              ■
            </button>
          )}
          {!running && filePath && (
            <button className="workspace-terminal-action-btn" onClick={run} title="Re-run">
              ▶
            </button>
          )}
          <button className="workspace-terminal-action-btn" onClick={handleClear} title="Clear">
            ✕
          </button>
        </div>
      </div>
      <div className="workspace-output-content" ref={outputRef}>
        {isStreaming && (
          <>
            {streamStatus && (
              <div className="workspace-output-status">
                <span className="workspace-output-spinner" />
                {streamStatus}
              </div>
            )}
            {streamStderr.length > 0 && (
              <pre className="workspace-output-stderr">{streamStderr.join('\n')}</pre>
            )}
            {streamStdout.length > 0 && (
              <pre className="workspace-output-stdout">{streamStdout.join('\n')}</pre>
            )}
          </>
        )}
        {!isStreaming && output && (
          <>
            {output.stdout && <pre className="workspace-output-stdout">{output.stdout}</pre>}
            {output.stderr && (
              <details className="workspace-output-stderr-details">
                <summary>Runtime logs</summary>
                <pre className="workspace-output-stderr">{output.stderr}</pre>
              </details>
            )}
            {!output.stdout && !output.stderr && (
              <div className="workspace-output-placeholder">No output</div>
            )}
          </>
        )}
        {!isStreaming && !output && !error && (
          <div className="workspace-output-placeholder">Click ▶ to run {fileName}...</div>
        )}
        {error && <div className="workspace-output-error">{error}</div>}
      </div>
    </div>
  )
}
