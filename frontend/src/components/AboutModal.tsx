import { useEffect, useState } from 'react'
import { getVersion } from '@tauri-apps/api/app'
import { getClient } from '../api/client'
import './AboutModal.css'
import Tooltip from './Tooltip'
import ModalFrame from './ModalFrame'

interface AboutModalProps {
  isOpen: boolean
  onClose: () => void
}

interface AppInfo {
  name: string
  version: string
  mode: string
}

export default function AboutModal({ isOpen, onClose }: AboutModalProps) {
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null)
  const [isLoading, setIsLoading] = useState(false)

  useEffect(() => {
    if (!isOpen) return
    let cancelled = false
    setIsLoading(true)
    ;(async () => {
      try {
        const { data } = await getClient().http.get<AppInfo>('/info')
        if (!cancelled) setAppInfo(data)
      } catch (error) {
        try {
          const tauriVersion = await getVersion()
          if (!cancelled) setAppInfo({ name: 'NetStacks', version: tauriVersion, mode: 'Enterprise' })
        } catch {
          if (!cancelled) console.error('Failed to fetch app info:', error)
        }
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [isOpen])

  if (!isOpen) {
    return null
  }

  return (
    <ModalFrame id="about" onDismiss={onClose} resizable={false} className="about-modal" testId="about-modal" label="About NetStacks">
      <div className="about-modal-header">
        <h2>About NetStacks</h2>
        <Tooltip label="Close"><button className="ns-btn ns-btn--ghost ns-icon-btn" onClick={onClose} aria-label="Close" autoFocus>
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
            <path
              d="M5 5L15 15M5 15L15 5"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
        </button></Tooltip>
      </div>

      <div className="about-modal-body">
        <div className="about-logo">
          <svg width="64" height="64" viewBox="0 0 64 64" fill="none">
            <rect x="8" y="8" width="48" height="48" rx="8" stroke="#0066cc" strokeWidth="3" />
            <path
              d="M16 24L24 32L16 40M32 40H48"
              stroke="#0066cc"
              strokeWidth="3"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>

        <div className="about-version">
          <h3>NetStacks</h3>
          {isLoading ? (
            <p>Loading version...</p>
          ) : appInfo ? (
            <p>Version {appInfo.version}</p>
          ) : (
            <p>Version unavailable</p>
          )}
        </div>

        <div className="about-copyright">
          <p>© 2024-2026 NetStacks. All rights reserved.</p>
        </div>

        <div className="about-credits">
          <h4>Built with</h4>
          <ul>
            <li>Tauri - Desktop application framework</li>
            <li>React - User interface library</li>
            <li>Rust - Systems programming language</li>
            <li>xterm.js - Terminal emulator</li>
          </ul>
        </div>

        <div className="about-licenses">
          <h4>Open Source Licenses</h4>
          <details>
            <summary>russh (Apache-2.0)</summary>
            <p>
              SSH client and server library for Rust.
              <br />
              Licensed under the Apache License, Version 2.0.
            </p>
          </details>
          <details>
            <summary>React (MIT)</summary>
            <p>
              A JavaScript library for building user interfaces.
              <br />
              Copyright (c) Meta Platforms, Inc. and affiliates.
              <br />
              Licensed under the MIT License.
            </p>
          </details>
          <details>
            <summary>Tauri (Apache-2.0 / MIT)</summary>
            <p>
              Build smaller, faster, and more secure desktop applications with a web frontend.
              <br />
              Licensed under Apache-2.0 and MIT.
            </p>
          </details>
          <details>
            <summary>xterm.js (MIT)</summary>
            <p>
              A terminal frontend for the web platform.
              <br />
              Copyright (c) 2017-2024, The xterm.js authors.
              <br />
              Licensed under the MIT License.
            </p>
          </details>
          <details>
            <summary>tokio (MIT)</summary>
            <p>
              A runtime for writing reliable asynchronous applications with Rust.
              <br />
              Copyright (c) 2024 Tokio Contributors.
              <br />
              Licensed under the MIT License.
            </p>
          </details>
          <details>
            <summary>Axum (MIT)</summary>
            <p>
              Ergonomic and modular web framework built with Tokio, Tower, and Hyper.
              <br />
              Licensed under the MIT License.
            </p>
          </details>
        </div>
      </div>
    </ModalFrame>
  )
}
