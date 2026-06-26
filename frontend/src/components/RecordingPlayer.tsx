import { useEffect, useRef, useState, useCallback } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import './RecordingPlayer.css'
import { getRecording, getRecordingData, type Recording } from '../api/recordings'

import { getErrorMessage } from '../api/errors'
interface RecordingEvent {
  time: number
  type: 'o' | 'i'  // output or input
  data: string
}

interface RecordingPlayerProps {
  recordingId: string
  onClose?: () => void
}

export default function RecordingPlayer({ recordingId, onClose }: RecordingPlayerProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<XTerm | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const eventsRef = useRef<RecordingEvent[]>([])
  const playbackIntervalRef = useRef<number | null>(null)
  const currentIndexRef = useRef(0)
  const startTimeRef = useRef(0)

  const [recording, setRecording] = useState<Recording | null>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [isPaused, setIsPaused] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [totalDuration, setTotalDuration] = useState(0)
  const [playbackSpeed, setPlaybackSpeed] = useState(1)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const terminalDimsRef = useRef<{ cols: number; rows: number }>({ cols: 80, rows: 24 })

  // Parse asciicast v2 format
  const parseAsciicast = useCallback((content: string): { cols: number; rows: number; events: RecordingEvent[] } => {
    const lines = content.trim().split('\n')
    if (lines.length === 0) {
      throw new Error('Empty recording file')
    }

    // First line is the header
    const header = JSON.parse(lines[0])
    if (header.version !== 2) {
      throw new Error(`Unsupported asciicast version: ${header.version}`)
    }

    const cols = header.width || 80
    const rows = header.height || 24
    const events: RecordingEvent[] = []

    // Parse events
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim()
      if (!line) continue

      try {
        const event = JSON.parse(line)
        if (Array.isArray(event) && event.length >= 3) {
          events.push({
            time: event[0] as number,
            type: event[1] as 'o' | 'i',
            data: event[2] as string,
          })
        }
      } catch {
        console.warn('Failed to parse event line:', line)
      }
    }

    return { cols, rows, events }
  }, [])

  // Load recording
  useEffect(() => {
    let mounted = true

    async function loadRecording() {
      try {
        setLoading(true)
        setError(null)

        // Fetch recording metadata and content
        const [recordingData, content] = await Promise.all([
          getRecording(recordingId),
          getRecordingData(recordingId),
        ])

        if (!mounted) return

        setRecording(recordingData)

        // Parse the asciicast content
        const { cols, rows, events } = parseAsciicast(content)
        eventsRef.current = events
        terminalDimsRef.current = { cols, rows }

        // Calculate total duration from last event
        const lastEvent = events[events.length - 1]
        const duration = lastEvent ? lastEvent.time * 1000 : recordingData.duration_ms
        setTotalDuration(duration)

        setLoading(false)
      } catch (err) {
        if (!mounted) return
        console.error('Failed to load recording:', err)
        setError(getErrorMessage(err, 'Failed to load recording'))
        setLoading(false)
      }
    }

    loadRecording()

    return () => {
      mounted = false
      if (playbackIntervalRef.current) {
        window.clearInterval(playbackIntervalRef.current)
      }
      terminalRef.current?.dispose()
    }
  }, [recordingId, parseAsciicast])

  // Initialize xterm terminal after loading completes and container DOM is available
  useEffect(() => {
    if (loading || error || terminalRef.current) return
    if (!containerRef.current) return

    const { cols, rows } = terminalDimsRef.current
    const terminal = new XTerm({
      cursorBlink: false,
      cursorStyle: 'block',
      fontSize: 14,
      fontFamily: 'Menlo, Monaco, Consolas, monospace',
      cols,
      rows,
      disableStdin: true,
      theme: {
        background: '#1e1e1e',
        foreground: '#d4d4d4',
        cursor: '#ffffff',
        cursorAccent: '#000000',
        selectionBackground: '#264f78',
      },
    })

    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)
    terminal.open(containerRef.current)

    terminalRef.current = terminal
    fitAddonRef.current = fitAddon

    // Initial fit after DOM layout settles
    setTimeout(() => fitAddon.fit(), 0)
  }, [loading, error])

  // Play recording
  const play = useCallback(() => {
    if (!terminalRef.current || eventsRef.current.length === 0) return

    if (isPaused) {
      // Resume from pause
      setIsPaused(false)
      setIsPlaying(true)
      startTimeRef.current = performance.now() - (currentTime / playbackSpeed)
    } else {
      // Start from beginning or current position
      setIsPlaying(true)
      setIsPaused(false)

      if (currentIndexRef.current === 0) {
        // Clear terminal for fresh start
        terminalRef.current.clear()
        startTimeRef.current = performance.now()
      } else {
        startTimeRef.current = performance.now() - (currentTime / playbackSpeed)
      }
    }

    // Start playback loop
    const processEvents = () => {
      if (!terminalRef.current) return

      const elapsed = (performance.now() - startTimeRef.current) * playbackSpeed
      setCurrentTime(elapsed)

      // Process all events up to current time
      while (currentIndexRef.current < eventsRef.current.length) {
        const event = eventsRef.current[currentIndexRef.current]
        const eventTimeMs = event.time * 1000

        if (eventTimeMs <= elapsed) {
          // Only render output events
          if (event.type === 'o') {
            terminalRef.current.write(event.data)
          }
          currentIndexRef.current++
        } else {
          break
        }
      }

      // Check if playback is complete
      if (currentIndexRef.current >= eventsRef.current.length) {
        window.clearInterval(playbackIntervalRef.current!)
        playbackIntervalRef.current = null
        setIsPlaying(false)
      }
    }

    // Run at 60fps
    playbackIntervalRef.current = window.setInterval(processEvents, 16)
  }, [isPaused, currentTime, playbackSpeed])

  // Pause playback
  const pause = useCallback(() => {
    if (playbackIntervalRef.current) {
      window.clearInterval(playbackIntervalRef.current)
      playbackIntervalRef.current = null
    }
    setIsPlaying(false)
    setIsPaused(true)
  }, [])

  // Stop playback and reset
  const stop = useCallback(() => {
    if (playbackIntervalRef.current) {
      window.clearInterval(playbackIntervalRef.current)
      playbackIntervalRef.current = null
    }
    setIsPlaying(false)
    setIsPaused(false)
    setCurrentTime(0)
    currentIndexRef.current = 0
    terminalRef.current?.clear()
  }, [])

  // Seek to a specific time
  const seek = useCallback((timeMs: number) => {
    if (!terminalRef.current) return

    // Stop current playback
    if (playbackIntervalRef.current) {
      window.clearInterval(playbackIntervalRef.current)
      playbackIntervalRef.current = null
    }

    // Clear terminal and replay to target time
    terminalRef.current.clear()

    // Find events up to target time and replay them
    let lastIndex = 0
    for (let i = 0; i < eventsRef.current.length; i++) {
      const event = eventsRef.current[i]
      const eventTimeMs = event.time * 1000

      if (eventTimeMs <= timeMs) {
        if (event.type === 'o') {
          terminalRef.current.write(event.data)
        }
        lastIndex = i + 1
      } else {
        break
      }
    }

    currentIndexRef.current = lastIndex
    setCurrentTime(timeMs)
    startTimeRef.current = performance.now() - (timeMs / playbackSpeed)

    // If was playing, continue playing
    if (isPlaying) {
      play()
    } else {
      setIsPaused(true)
    }
  }, [isPlaying, playbackSpeed, play])

  // Format time for display
  const formatTime = (ms: number) => {
    const totalSeconds = Math.floor(ms / 1000)
    const minutes = Math.floor(totalSeconds / 60)
    const seconds = totalSeconds % 60
    return `${minutes}:${seconds.toString().padStart(2, '0')}`
  }

  // Handle progress bar click
  const handleProgressClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - rect.left
    const percent = x / rect.width
    const targetTime = percent * totalDuration
    seek(targetTime)
  }, [totalDuration, seek])

  // Handle window resize
  useEffect(() => {
    const handleResize = () => {
      fitAddonRef.current?.fit()
    }

    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  if (loading) {
    return (
      <div className="recording-player recording-player-loading">
        <div className="recording-player-spinner" />
        <span>Loading recording...</span>
      </div>
    )
  }

  if (error) {
    return (
      <div className="recording-player recording-player-error">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="12" />
          <circle cx="12" cy="16" r="1" fill="currentColor" />
        </svg>
        <span>{error}</span>
        {onClose && (
          <button onClick={onClose} className="recording-player-error-close">
            Close
          </button>
        )}
      </div>
    )
  }

  return (
    <div className="recording-player">
      {/* Header */}
      <div className="recording-player-header">
        <div className="recording-player-title">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10" />
            <polygon points="10,8 16,12 10,16" fill="currentColor" />
          </svg>
          <span>{recording?.name || 'Recording'}</span>
        </div>
        {onClose && (
          <button onClick={onClose} className="recording-player-close">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        )}
      </div>

      {/* Terminal display */}
      <div className="recording-player-terminal" ref={containerRef} />

      {/* Controls */}
      <div className="recording-player-controls">
        {/* Playback buttons */}
        <div className="recording-player-buttons">
          <button onClick={stop} className="recording-player-btn" title="Stop">
            <svg viewBox="0 0 24 24" fill="currentColor">
              <rect x="6" y="6" width="12" height="12" />
            </svg>
          </button>

          {isPlaying ? (
            <button onClick={pause} className="recording-player-btn recording-player-btn-primary" title="Pause">
              <svg viewBox="0 0 24 24" fill="currentColor">
                <rect x="6" y="4" width="4" height="16" />
                <rect x="14" y="4" width="4" height="16" />
              </svg>
            </button>
          ) : (
            <button onClick={play} className="recording-player-btn recording-player-btn-primary" title="Play">
              <svg viewBox="0 0 24 24" fill="currentColor">
                <polygon points="5,3 19,12 5,21" />
              </svg>
            </button>
          )}
        </div>

        {/* Progress bar */}
        <div className="recording-player-progress" onClick={handleProgressClick}>
          <div
            className="recording-player-progress-fill"
            style={{ width: `${totalDuration > 0 ? (currentTime / totalDuration) * 100 : 0}%` }}
          />
        </div>

        {/* Time display */}
        <div className="recording-player-time">
          {formatTime(currentTime)} / {formatTime(totalDuration)}
        </div>

        {/* Speed control */}
        <div className="recording-player-speed">
          <select
            value={playbackSpeed}
            onChange={(e) => setPlaybackSpeed(Number(e.target.value))}
            className="recording-player-speed-select"
          >
            <option value={0.5}>0.5x</option>
            <option value={1}>1x</option>
            <option value={1.5}>1.5x</option>
            <option value={2}>2x</option>
            <option value={4}>4x</option>
          </select>
        </div>
      </div>
    </div>
  )
}
