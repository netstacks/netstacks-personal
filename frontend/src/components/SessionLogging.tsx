/**
 * SessionLogging - Log format selection and control
 */

import { useState, useCallback } from 'react'
import './SessionLogging.css'
import { stripAnsi } from '../lib/ansi'
export { stripAnsi }

export type LogFormat = 'plain' | 'raw' | 'html'

export interface LoggingState {
  isLogging: boolean
  format: LogFormat
  withTimestamps: boolean
  filePath: string | null
}

interface SessionLoggingProps {
  terminalId: string
  isLogging: boolean
  logFormat: LogFormat
  logTimestamps: boolean
  logFilePath: string | null
  onStartLogging: (format: LogFormat, timestamps: boolean) => Promise<void>
  onStopLogging: () => void
  onFormatChange: (format: LogFormat) => void
  onTimestampsChange: (enabled: boolean) => void
}

// Icons
const RecordIcon = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14">
    <circle cx="12" cy="12" r="8" />
  </svg>
)

const StopIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
    <rect x="6" y="6" width="12" height="12" rx="2" />
  </svg>
)

export default function SessionLogging({
  terminalId,
  isLogging,
  logFormat,
  logTimestamps,
  logFilePath,
  onStartLogging,
  onStopLogging,
  onFormatChange,
  onTimestampsChange,
}: SessionLoggingProps) {
  const [isStarting, setIsStarting] = useState(false)

  const handleStartClick = useCallback(async () => {
    setIsStarting(true)
    try {
      await onStartLogging(logFormat, logTimestamps)
    } catch (err) {
      console.error('Failed to start logging:', err)
    } finally {
      setIsStarting(false)
    }
  }, [onStartLogging, logFormat, logTimestamps])

  const handleStopClick = useCallback(() => {
    onStopLogging()
  }, [onStopLogging])

  return (
    <div className="session-logging">
      <div className="logging-header">
        <span className="logging-title">Session Logging</span>
        {isLogging && (
          <span className="logging-status recording">
            <RecordIcon />
            Recording
          </span>
        )}
      </div>

      <div className="logging-controls">
        <div className="logging-format-group">
          <label className="logging-label">Format:</label>
          <div className="logging-format-options">
            <label className={`logging-format-option ${logFormat === 'plain' ? 'selected' : ''}`}>
              <input
                type="radio"
                name={`log-format-${terminalId}`}
                value="plain"
                checked={logFormat === 'plain'}
                onChange={() => onFormatChange('plain')}
                disabled={isLogging}
              />
              <span>Plain Text</span>
            </label>
            <label className={`logging-format-option ${logFormat === 'raw' ? 'selected' : ''}`}>
              <input
                type="radio"
                name={`log-format-${terminalId}`}
                value="raw"
                checked={logFormat === 'raw'}
                onChange={() => onFormatChange('raw')}
                disabled={isLogging}
              />
              <span>Raw (ANSI)</span>
            </label>
            <label className={`logging-format-option ${logFormat === 'html' ? 'selected' : ''}`}>
              <input
                type="radio"
                name={`log-format-${terminalId}`}
                value="html"
                checked={logFormat === 'html'}
                onChange={() => onFormatChange('html')}
                disabled={isLogging}
              />
              <span>HTML</span>
            </label>
          </div>
        </div>

        <label className="logging-checkbox-option">
          <input
            type="checkbox"
            checked={logTimestamps}
            onChange={(e) => onTimestampsChange(e.target.checked)}
            disabled={isLogging}
          />
          <span>Timestamp each line</span>
        </label>

        {logFilePath && (
          <div className="logging-path">
            <span className="logging-label">File:</span>
            <span className="logging-path-value" title={logFilePath}>
              {logFilePath.split('/').pop()}
            </span>
          </div>
        )}
      </div>

      <div className="logging-actions">
        {!isLogging ? (
          <button
            className="logging-btn logging-btn-start"
            onClick={handleStartClick}
            disabled={isStarting}
          >
            <RecordIcon />
            {isStarting ? 'Starting...' : 'Start Logging'}
          </button>
        ) : (
          <button
            className="logging-btn logging-btn-stop"
            onClick={handleStopClick}
          >
            <StopIcon />
            Stop Logging
          </button>
        )}
      </div>
    </div>
  )
}

/**
 * Utility functions for log processing
 */

// stripAnsi is now in ../lib/ansi

// Add timestamp to a line
export function addTimestamp(line: string): string {
  const now = new Date()
  const timestamp = now.toISOString().replace('T', ' ').replace('Z', '')
  return `[${timestamp}] ${line}`
}

// Convert ANSI to HTML with inline styles
export function ansiToHtml(text: string): string {
  const ansiColors: Record<string, string> = {
    '30': '#000000',
    '31': '#cd3131',
    '32': '#0dbc79',
    '33': '#e5e510',
    '34': '#2472c8',
    '35': '#bc3fbc',
    '36': '#11a8cd',
    '37': '#e5e5e5',
    '90': '#666666',
    '91': '#f14c4c',
    '92': '#23d18b',
    '93': '#f5f543',
    '94': '#3b8eea',
    '95': '#d670d6',
    '96': '#29b8db',
    '97': '#ffffff',
  }

  const bgColors: Record<string, string> = {
    '40': '#000000',
    '41': '#cd3131',
    '42': '#0dbc79',
    '43': '#e5e510',
    '44': '#2472c8',
    '45': '#bc3fbc',
    '46': '#11a8cd',
    '47': '#e5e5e5',
  }

  let result = '<pre style="font-family: monospace; background: #1e1e1e; color: #cccccc; padding: 10px;">'
  let currentStyle = ''
  let i = 0

  while (i < text.length) {
    // Check for ANSI escape sequence
    if (text[i] === '\x1b' && text[i + 1] === '[') {
      const endIndex = text.indexOf('m', i)
      if (endIndex !== -1) {
        const codes = text.slice(i + 2, endIndex).split(';')

        // Close previous span if there was a style
        if (currentStyle) {
          result += '</span>'
        }

        // Build new style
        let fg = ''
        let bg = ''
        let bold = false

        for (const code of codes) {
          if (code === '0') {
            // Reset
            fg = ''
            bg = ''
            bold = false
          } else if (code === '1') {
            bold = true
          } else if (ansiColors[code]) {
            fg = ansiColors[code]
          } else if (bgColors[code]) {
            bg = bgColors[code]
          }
        }

        const styles: string[] = []
        if (fg) styles.push(`color: ${fg}`)
        if (bg) styles.push(`background: ${bg}`)
        if (bold) styles.push('font-weight: bold')

        currentStyle = styles.join('; ')
        if (currentStyle) {
          result += `<span style="${currentStyle}">`
        }

        i = endIndex + 1
        continue
      }
    }

    // Escape HTML special characters
    const char = text[i]
    if (char === '<') {
      result += '&lt;'
    } else if (char === '>') {
      result += '&gt;'
    } else if (char === '&') {
      result += '&amp;'
    } else if (char === '\n') {
      result += '\n'
    } else {
      result += char
    }

    i++
  }

  // Close any open span
  if (currentStyle) {
    result += '</span>'
  }

  result += '</pre>'
  return result
}

// Process terminal output for logging
export function processForLog(
  data: string,
  format: LogFormat,
  withTimestamps: boolean
): string {
  let processed = data

  switch (format) {
    case 'plain':
      processed = stripAnsi(data)
      break
    case 'html':
      processed = ansiToHtml(data)
      break
    case 'raw':
    default:
      // Keep raw output
      break
  }

  if (withTimestamps && format !== 'html') {
    // Add timestamps to each line
    const lines = processed.split('\n')
    processed = lines.map(line => line ? addTimestamp(line) : '').join('\n')
  }

  return processed
}
