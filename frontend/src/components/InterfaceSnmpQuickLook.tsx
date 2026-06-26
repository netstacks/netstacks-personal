// InterfaceSnmpQuickLook - Floating SNMP interface stats overlay with two-sample rate calculation
// Right-click an interface name in a terminal session to see live SNMP stats

import { useState, useEffect, useRef, useCallback } from 'react'
import { snmpTryInterfaceStats, type SnmpInterfaceStatsResponse } from '../api/snmp'
import { formatRate } from '../utils/formatRate'
import { getCurrentMode } from '../api/client'
import './InterfaceSnmpQuickLook.css'

import { getErrorMessage } from '../api/errors'
interface InterfaceSnmpQuickLookProps {
  interfaceName: string
  deviceHost: string
  profileId: string
  /** Jump configured for the parent session, if any. When set, SNMP queries
   *  route through the bastion (net-snmp CLI on the jump host) instead of
   *  going direct over UDP. Mutually exclusive — at most one. */
  jumpHostId?: string | null
  jumpSessionId?: string | null
  deviceId?: string
  position: { x: number; y: number }
  onClose: () => void
}

type PollState = 'polling-first' | 'waiting' | 'polling-second' | 'complete' | 'error'

interface Sample {
  stats: SnmpInterfaceStatsResponse
  timestamp: number
}

interface RateData {
  inBps: number
  outBps: number
  inErrorsDelta: number
  outErrorsDelta: number
  inDiscardsDelta: number
  outDiscardsDelta: number
  sampleDurationSec: number
}

// Counter wrap threshold for 32-bit counters
const COUNTER_32_MAX = 2 ** 32

/**
 * Calculate the delta between two counter values, handling 32-bit counter wrap.
 */
function counterDelta(current: number, previous: number, hcCounters: boolean): number {
  const delta = current - previous
  if (delta >= 0) return delta
  // Counter wrapped — only correct for 32-bit counters
  if (!hcCounters) return delta + COUNTER_32_MAX
  // HC 64-bit counters should not wrap in practice; treat negative as 0
  return 0
}

/** SVG Icons */
const Icons = {
  close: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  ),
  refresh: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="14" height="14">
      <polyline points="23 4 23 10 17 10" />
      <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
    </svg>
  ),
  arrowDown: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="12" height="12">
      <line x1="12" y1="5" x2="12" y2="19" />
      <polyline points="19 12 12 19 5 12" />
    </svg>
  ),
  arrowUp: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="12" height="12">
      <line x1="12" y1="19" x2="12" y2="5" />
      <polyline points="5 12 12 5 19 12" />
    </svg>
  ),
  ethernet: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="16" height="16">
      <rect x="2" y="6" width="20" height="12" rx="2" />
      <path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01" />
      <path d="M6 14h12" />
    </svg>
  ),
}

export default function InterfaceSnmpQuickLook({
  interfaceName,
  deviceHost,
  profileId,
  jumpHostId,
  jumpSessionId,
  deviceId,
  position,
  onClose,
}: InterfaceSnmpQuickLookProps) {
  const isEnterprise = getCurrentMode() === 'enterprise'
  const overlayRef = useRef<HTMLDivElement>(null)
  const [pollState, setPollState] = useState<PollState>('polling-first')
  const [firstSample, setFirstSample] = useState<Sample | null>(null)
  const [secondSample, setSecondSample] = useState<Sample | null>(null)
  const [rateData, setRateData] = useState<RateData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [countdown, setCountdown] = useState(5)
  const [polledAgo, setPolledAgo] = useState(0)
  const cancelledRef = useRef(false)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const polledTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Cleanup all timers
  const clearTimers = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
    if (polledTimerRef.current) {
      clearInterval(polledTimerRef.current)
      polledTimerRef.current = null
    }
  }, [])

  // Poll function
  const poll = useCallback(async (): Promise<Sample | null> => {
    const stats = await snmpTryInterfaceStats(
      isEnterprise
        ? { deviceId, interfaceName }
        : {
            host: deviceHost,
            profileId,
            interfaceName,
            jump_host_id: jumpHostId,
            jump_session_id: jumpSessionId,
          }
    )
    return { stats, timestamp: Date.now() }
  }, [deviceHost, profileId, interfaceName, isEnterprise, deviceId, jumpHostId, jumpSessionId])

  // Start the two-sample cycle
  const startPolling = useCallback(async () => {
    cancelledRef.current = false
    setError(null)
    setFirstSample(null)
    setSecondSample(null)
    setRateData(null)
    setPollState('polling-first')
    setCountdown(5)
    setPolledAgo(0)
    clearTimers()

    try {
      // First sample
      const sample1 = await poll()
      if (cancelledRef.current || !sample1) return
      setFirstSample(sample1)
      setPollState('waiting')

      // Countdown timer (5 seconds between samples)
      let remaining = 5
      setCountdown(remaining)
      await new Promise<void>((resolve) => {
        timerRef.current = setInterval(() => {
          remaining--
          setCountdown(remaining)
          if (remaining <= 0) {
            if (timerRef.current) clearInterval(timerRef.current)
            timerRef.current = null
            resolve()
          }
        }, 1000)
      })

      if (cancelledRef.current) return

      // Second sample
      setPollState('polling-second')
      const sample2 = await poll()
      if (cancelledRef.current || !sample2) return
      setSecondSample(sample2)

      // Calculate rates
      const durationSec = (sample2.timestamp - sample1.timestamp) / 1000
      const s1 = sample1.stats
      const s2 = sample2.stats

      const inOctetsDelta = counterDelta(s2.inOctets, s1.inOctets, s2.hcCounters)
      const outOctetsDelta = counterDelta(s2.outOctets, s1.outOctets, s2.hcCounters)

      setRateData({
        inBps: (inOctetsDelta / durationSec) * 8,
        outBps: (outOctetsDelta / durationSec) * 8,
        inErrorsDelta: counterDelta(s2.inErrors, s1.inErrors, s2.hcCounters),
        outErrorsDelta: counterDelta(s2.outErrors, s1.outErrors, s2.hcCounters),
        inDiscardsDelta: counterDelta(s2.inDiscards, s1.inDiscards, s2.hcCounters),
        outDiscardsDelta: counterDelta(s2.outDiscards, s1.outDiscards, s2.hcCounters),
        sampleDurationSec: durationSec,
      })
      setPollState('complete')

      // Start "polled ago" counter
      setPolledAgo(0)
      polledTimerRef.current = setInterval(() => {
        setPolledAgo((prev) => prev + 1)
      }, 1000)
    } catch (err) {
      if (cancelledRef.current) return
      setError(getErrorMessage(err, 'SNMP poll failed'))
      setPollState('error')
    }
  }, [poll, clearTimers])

  // Start polling on mount
  useEffect(() => {
    startPolling()
    return () => {
      cancelledRef.current = true
      clearTimers()
    }
  }, [startPolling, clearTimers])

  // Close on Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  // Close on click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (overlayRef.current && !overlayRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside)
    }, 100)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [onClose])

  // Viewport-aware positioning
  const overlayWidth = 360
  const overlayHeight = 320
  const padding = 20

  let left = position.x
  let top = position.y + 10

  if (left + overlayWidth > window.innerWidth - padding) {
    left = window.innerWidth - overlayWidth - padding
  }
  if (left < padding) left = padding
  if (top + overlayHeight > window.innerHeight - padding) {
    top = position.y - overlayHeight - 10
  }
  if (top < padding) top = padding

  // Get the latest stats to display (second sample preferred, fallback to first)
  const displayStats = secondSample?.stats || firstSample?.stats

  // Oper status color
  const getStatusColor = (status: number): string => {
    switch (status) {
      case 1: return 'var(--success-color, #4caf50)' // up
      case 2: return 'var(--error-color, #f44336)'   // down
      case 3: return 'var(--warning-color, #ff9800)'  // testing
      default: return 'rgba(255, 255, 255, 0.5)'      // unknown
    }
  }

  const handleRefresh = () => {
    cancelledRef.current = true
    clearTimers()
    // Small delay to allow cancellation to propagate
    setTimeout(() => startPolling(), 50)
  }

  return (
    <div
      ref={overlayRef}
      className="snmp-quicklook"
      style={{ left, top }}
    >
      {/* Header */}
      <div className="snmp-quicklook-header">
        <div className="snmp-quicklook-header-left">
          <span className="snmp-quicklook-icon">{Icons.ethernet}</span>
          <div className="snmp-quicklook-title-group">
            <span className="snmp-quicklook-title">
              {displayStats?.ifDescr || interfaceName}
            </span>
            <span className="snmp-quicklook-subtitle">
              {deviceHost}
              {displayStats && (
                <>
                  {' '}&middot;{' '}
                  <span style={{ color: getStatusColor(displayStats.operStatus) }}>
                    {displayStats.operStatusText}
                  </span>
                  {displayStats.speedMbps > 0 && (
                    <>
                      {' '}&middot; {displayStats.speedMbps >= 1000
                        ? `${(displayStats.speedMbps / 1000).toFixed(0)} Gbps`
                        : `${displayStats.speedMbps} Mbps`}
                    </>
                  )}
                </>
              )}
            </span>
          </div>
        </div>
        <button
          className="snmp-quicklook-close"
          onClick={onClose}
          title="Close (Escape)"
        >
          {Icons.close}
        </button>
      </div>

      {/* Description / alias */}
      {displayStats?.ifAlias && (
        <div className="snmp-quicklook-description">
          {displayStats.ifAlias}
        </div>
      )}

      {/* Content area */}
      <div className="snmp-quicklook-body">
        {/* Loading state */}
        {(pollState === 'polling-first' || pollState === 'polling-second') && (
          <div className="snmp-quicklook-loading">
            <div className="snmp-quicklook-spinner" />
            <span>
              {pollState === 'polling-first' ? 'Polling...' : 'Collecting second sample...'}
            </span>
          </div>
        )}

        {/* Waiting countdown */}
        {pollState === 'waiting' && (
          <div className="snmp-quicklook-loading">
            <div className="snmp-quicklook-countdown-ring">
              <svg viewBox="0 0 36 36" width="32" height="32">
                <circle
                  cx="18" cy="18" r="15"
                  fill="none"
                  stroke="rgba(255,255,255,0.1)"
                  strokeWidth="3"
                />
                <circle
                  cx="18" cy="18" r="15"
                  fill="none"
                  stroke="var(--accent-color, #2196f3)"
                  strokeWidth="3"
                  strokeDasharray={`${(1 - countdown / 5) * 94.25} 94.25`}
                  strokeLinecap="round"
                  transform="rotate(-90 18 18)"
                  style={{ transition: 'stroke-dasharray 1s linear' }}
                />
              </svg>
              <span className="snmp-quicklook-countdown-text">{countdown}</span>
            </div>
            <span>Calculating rates...</span>
          </div>
        )}

        {/* Error state */}
        {pollState === 'error' && (
          <div className="snmp-quicklook-error">
            <span className="snmp-quicklook-error-text">{error}</span>
            <button className="snmp-quicklook-retry-btn" onClick={handleRefresh}>
              {Icons.refresh}
              <span>Retry</span>
            </button>
          </div>
        )}

        {/* Rate display (complete state) */}
        {pollState === 'complete' && rateData && (
          <>
            <div className="snmp-quicklook-rates">
              <div className="snmp-quicklook-rate-card in">
                <div className="snmp-quicklook-rate-label">
                  {Icons.arrowDown}
                  <span>In</span>
                </div>
                <div className="snmp-quicklook-rate-value">
                  {formatRate(rateData.inBps)}
                </div>
              </div>
              <div className="snmp-quicklook-rate-card out">
                <div className="snmp-quicklook-rate-label">
                  {Icons.arrowUp}
                  <span>Out</span>
                </div>
                <div className="snmp-quicklook-rate-value">
                  {formatRate(rateData.outBps)}
                </div>
              </div>
            </div>

            <div className="snmp-quicklook-counters">
              <div className="snmp-quicklook-counter-row">
                <span className="snmp-quicklook-counter-label">Errors In</span>
                <span className={`snmp-quicklook-counter-value ${rateData.inErrorsDelta > 0 ? 'warn' : ''}`}>
                  {rateData.inErrorsDelta}
                </span>
                <span className="snmp-quicklook-counter-label">Errors Out</span>
                <span className={`snmp-quicklook-counter-value ${rateData.outErrorsDelta > 0 ? 'warn' : ''}`}>
                  {rateData.outErrorsDelta}
                </span>
              </div>
              <div className="snmp-quicklook-counter-row">
                <span className="snmp-quicklook-counter-label">Discards</span>
                <span className={`snmp-quicklook-counter-value ${rateData.inDiscardsDelta > 0 ? 'warn' : ''}`}>
                  {rateData.inDiscardsDelta}
                </span>
                <span className="snmp-quicklook-counter-label">Discards</span>
                <span className={`snmp-quicklook-counter-value ${rateData.outDiscardsDelta > 0 ? 'warn' : ''}`}>
                  {rateData.outDiscardsDelta}
                </span>
              </div>
            </div>
          </>
        )}
      </div>

      {/* Footer */}
      <div className="snmp-quicklook-footer">
        {pollState === 'complete' ? (
          <>
            <button className="snmp-quicklook-refresh-btn" onClick={handleRefresh}>
              {Icons.refresh}
              <span>Refresh</span>
            </button>
            <span className="snmp-quicklook-polled-ago">
              Polled {polledAgo}s ago
              {!displayStats?.hcCounters && ' (32-bit)'}
            </span>
          </>
        ) : (
          <span className="snmp-quicklook-footer-hint">
            <kbd>Esc</kbd> to close
          </span>
        )}
      </div>
    </div>
  )
}
