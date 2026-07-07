import { useState, useEffect, useRef, useCallback } from 'react'
import type { CliFlavor } from '../types/enrichment'
import { useAIAgent } from '../hooks/useAIAgent'
import { useAssistantName } from '../stores/assistantName'
import { fetchOllamaModels, type AiProviderType, getAiConfig } from '../api/ai'
import { resolveProvider } from '../lib/aiProviderResolver'
import type { AiContext } from '../api/ai'
import type { Document, DocumentCategory } from '../api/docs'
import type { AgentMessage } from '../hooks/useAIAgent'
import AIContextSummary from './AIContextSummary'
import MarkdownViewer from './MarkdownViewer'
import './AIInlinePopup.css'

// Available session info for the agent
interface AvailableSession {
  id: string
  name: string
  connected: boolean
  cliFlavor?: string
}

interface AIInlinePopupProps {
  isOpen: boolean
  position: { x: number; y: number }
  action: 'explain' | 'fix' | 'suggest' | 'topology-device' | 'topology-link'
  selectedText: string
  onClose: () => void
  context?: AiContext
  // Current session the user is working in (from the terminal they right-clicked)
  sessionId?: string
  sessionName?: string
  // Session/terminal access callbacks (for full agent capability)
  availableSessions?: AvailableSession[]
  onExecuteCommand?: (sessionId: string, command: string) => Promise<string>
  getTerminalContext?: (sessionId: string, lines?: number) => Promise<string>
  // Document access callbacks
  onListDocuments?: (category?: DocumentCategory) => Promise<Document[]>
  onReadDocument?: (documentId: string, byName?: boolean) => Promise<Document | null>
  onSearchDocuments?: (query: string, category?: DocumentCategory) => Promise<Document[]>
  onSaveDocument?: (path: string, content: string, category?: DocumentCategory, mode?: 'overwrite' | 'append', sessionId?: string) => Promise<{ id: string; name: string }>
  // Callback to continue conversation in full panel
  onContinueInPanel?: (messages: AgentMessage[], context?: AiContext) => void
}

const AIInlinePopup = ({
  isOpen,
  position,
  action,
  selectedText,
  onClose,
  context,
  sessionId,
  sessionName,
  availableSessions,
  onExecuteCommand,
  getTerminalContext,
  onListDocuments,
  onReadDocument,
  onSearchDocuments,
  onSaveDocument,
  onContinueInPanel,
}: AIInlinePopupProps) => {
  const assistantName = useAssistantName()
  const popupRef = useRef<HTMLDivElement>(null)
  const hasSentRef = useRef(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const [input, setInput] = useState('')
  const [expandedResults, setExpandedResults] = useState<Set<string>>(new Set())

  // Provider/Model state (initialized from settings)
  const [selectedProvider, setSelectedProvider] = useState<AiProviderType | null>(null)
  const [selectedModel, setSelectedModel] = useState<string>('')
  const [providerInitialized, setProviderInitialized] = useState(false)

  // Initialize provider/model from settings on first open. Both provider and
  // model come from the user's settings via resolveProvider — never a hardcoded
  // model literal. ollama/custom add a runtime model source when settings is empty.
  useEffect(() => {
    if (isOpen && !providerInitialized) {
      const initProvider = async () => {
        const { provider, model } = resolveProvider('agent')
        const p = provider as AiProviderType
        setSelectedProvider(p)

        let resolvedModel = model
        if (p === 'ollama' && !resolvedModel) {
          try {
            const fetched = await fetchOllamaModels()
            if (fetched.length > 0) resolvedModel = fetched[0].value
          } catch { /* keep settings model */ }
        } else if (p === 'custom' && !resolvedModel) {
          try {
            const cfg = await getAiConfig()
            if (cfg?.provider === 'custom' && cfg.model) resolvedModel = cfg.model
          } catch { /* ignore */ }
        }
        setSelectedModel(resolvedModel)
        setProviderInitialized(true)
      }
      initProvider()
    }
  }, [isOpen, providerInitialized])

  // Reset initialization when closed
  useEffect(() => {
    if (!isOpen) {
      setProviderInitialized(false)
    }
  }, [isOpen])

  // Drag state
  const [pos, setPos] = useState({ x: 0, y: 0 })
  const [isDragging, setIsDragging] = useState(false)
  const dragOffset = useRef({ x: 0, y: 0 })

  // Resize state
  const [size, setSize] = useState({ width: 450, height: 400 })
  const [isResizing, setIsResizing] = useState(false)
  const resizeStart = useRef({ x: 0, y: 0, width: 0, height: 0 })

  // Use unified AI agent hook with ALL tools (no singleTurn - allow continuation)
  const {
    messages,
    agentState,
    sendMessage,
    stopAgent,
    clearMessages,
  } = useAIAgent({
    permissionMode: 'auto',
    provider: selectedProvider ?? undefined,
    model: selectedModel,
    // Session/terminal tools (map availableSessions to sessions for hook)
    sessions: availableSessions?.map(s => ({
      id: s.id,
      name: s.name,
      connected: s.connected,
      cliFlavor: s.cliFlavor as CliFlavor | undefined,
    })),
    onExecuteCommand,
    getTerminalContext,
    // Active session — injects device memory + device/tribal context for the
    // terminal this popup was opened from.
    activeSessionId: sessionId,
    activeSessionName: sessionName,
    // Document tools
    onListDocuments,
    onReadDocument,
    onSearchDocuments,
    onSaveDocument,
  })

  // Initialize position when opening
  useEffect(() => {
    if (isOpen) {
      // Adjust position to keep popup in viewport
      const popupWidth = size.width
      const popupHeight = size.height
      const adjustedX = Math.min(position.x, window.innerWidth - popupWidth - 20)
      const adjustedY = Math.min(position.y, window.innerHeight - popupHeight - 20)
      setPos({
        x: Math.max(20, adjustedX),
        y: Math.max(20, adjustedY),
      })
    }
  }, [isOpen, position, size.width, size.height])

  // Auto-send initial request when popup opens. Wait until the provider/model
  // are resolved (providerInitialized) — otherwise the first request races the
  // async init and goes out with a half-settled provider/model combo (causing a
  // "model not found" on the first message that succeeds on the next one).
  useEffect(() => {
    if (isOpen && providerInitialized && selectedText && messages.length === 0 && !hasSentRef.current) {
      hasSentRef.current = true
      // Include user intent from action, let system prompt guide how AI responds
      // This tells the AI what the user wants without overriding tool-use behavior
      let intent = ''
      if (action === 'explain') {
        intent = 'Explain this:'
      } else if (action === 'fix') {
        intent = 'Help me fix/debug this:'
      } else if (action === 'suggest') {
        intent = 'What should I do with this?'
      } else if (action === 'topology-device') {
        intent = 'Analyze this device:'
      } else if (action === 'topology-link') {
        intent = 'Analyze this network link:'
      }

      // Build prompt with session context so AI knows which session to use
      let prompt = ''
      if (sessionId && sessionName) {
        prompt = `[Working on session: ${sessionName} (ID: ${sessionId})]\n\n`
      }
      prompt += intent ? `${intent}\n\n${selectedText}` : selectedText

      sendMessage(prompt)
    }
  }, [isOpen, providerInitialized, selectedText, action, sessionId, sessionName, messages.length, sendMessage])

  // Handle follow-up message submission
  const handleSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault()
    if (!input.trim() || agentState !== 'idle') return
    sendMessage(input.trim())
    setInput('')
  }, [input, agentState, sendMessage])

  // Handle continue in panel
  const handleContinueInPanel = useCallback(() => {
    if (onContinueInPanel) {
      onContinueInPanel(messages, context)
      onClose()
    }
  }, [messages, context, onContinueInPanel, onClose])

  // Toggle command result expansion
  const toggleResultExpanded = useCallback((id: string) => {
    setExpandedResults(prev => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }, [])

  // Reset state when closed
  useEffect(() => {
    if (!isOpen) {
      clearMessages()
      hasSentRef.current = false
      setInput('')
      setExpandedResults(new Set())
    }
  }, [isOpen, clearMessages])

  // Close on Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    if (isOpen) {
      document.addEventListener('keydown', handleKeyDown)
      return () => document.removeEventListener('keydown', handleKeyDown)
    }
  }, [isOpen, onClose])

  // Drag handlers
  const handleDragStart = useCallback((e: React.MouseEvent) => {
    setIsDragging(true)
    dragOffset.current = {
      x: e.clientX - pos.x,
      y: e.clientY - pos.y
    }
    e.preventDefault()
  }, [pos])

  useEffect(() => {
    if (!isDragging) return

    const handleMouseMove = (e: MouseEvent) => {
      setPos({
        x: Math.max(0, Math.min(window.innerWidth - size.width, e.clientX - dragOffset.current.x)),
        y: Math.max(0, Math.min(window.innerHeight - size.height, e.clientY - dragOffset.current.y))
      })
    }

    const handleMouseUp = () => setIsDragging(false)

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isDragging, size])

  // Resize handlers
  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    setIsResizing(true)
    resizeStart.current = {
      x: e.clientX,
      y: e.clientY,
      width: size.width,
      height: size.height,
    }
    e.preventDefault()
    e.stopPropagation()
  }, [size])

  useEffect(() => {
    if (!isResizing) return

    const handleMouseMove = (e: MouseEvent) => {
      const deltaX = e.clientX - resizeStart.current.x
      const deltaY = e.clientY - resizeStart.current.y
      setSize({
        width: Math.max(300, Math.min(700, resizeStart.current.width + deltaX)),
        height: Math.max(250, Math.min(700, resizeStart.current.height + deltaY)),
      })
    }

    const handleMouseUp = () => setIsResizing(false)

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isResizing])

  if (!isOpen) return null

  const isLoading = agentState === 'thinking' || agentState === 'executing'

  return (
    <div
      ref={popupRef}
      className={`ai-inline-popup ${isDragging ? 'dragging' : ''} ${isResizing ? 'resizing' : ''}`}
      style={{
        left: pos.x,
        top: pos.y,
        width: size.width,
        height: size.height,
      }}
    >
      <div className="ai-inline-popup-header" onMouseDown={handleDragStart}>
        <span className="ai-inline-popup-title">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="14" height="14">
            <path d="M12 2L2 7l10 5 10-5-10-5z" />
            <path d="M2 17l10 5 10-5" />
            <path d="M2 12l10 5 10-5" />
          </svg>
          {assistantName}
        </span>
        <div className="ai-inline-popup-actions" onMouseDown={e => e.stopPropagation()}>
          {onContinueInPanel && messages.length > 0 && (
            <button className="ai-inline-popup-expand" onClick={handleContinueInPanel} title="Continue in panel">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
                <polyline points="15 3 21 3 21 9" />
                <polyline points="9 21 3 21 3 15" />
                <line x1="21" y1="3" x2="14" y2="10" />
                <line x1="3" y1="21" x2="10" y2="14" />
              </svg>
            </button>
          )}
          <button className="ai-inline-popup-close" onClick={onClose}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      </div>

      {/* Show context summary */}
      <div className="ai-inline-popup-context">
        <AIContextSummary context={context} />
      </div>

      {/* Messages area - shows full conversation */}
      <div className="ai-inline-popup-messages">
        {messages.map((msg) => {
          if (msg.type === 'user') {
            return (
              <div key={msg.id} className="ai-popup-message ai-popup-message-user">
                <div className="ai-popup-message-content">{msg.content}</div>
              </div>
            )
          } else if (msg.type === 'agent-thinking') {
            return (
              <div key={msg.id} className="ai-popup-message ai-popup-message-assistant">
                <div className="ai-popup-message-content">
                  <MarkdownViewer content={msg.content} />
                </div>
              </div>
            )
          } else if (msg.type === 'command-result') {
            const isExpanded = expandedResults.has(msg.id)
            const output = msg.output || msg.content
            const lineCount = output.split('\n').length
            return (
              <div key={msg.id} className={`ai-popup-message ai-popup-message-result ${isExpanded ? 'expanded' : ''}`}>
                <div className="ai-popup-result-header" onClick={() => toggleResultExpanded(msg.id)}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="12" height="12" className="ai-popup-result-chevron">
                    <polyline points="6 9 12 15 18 9" />
                  </svg>
                  <code className="ai-popup-command">{msg.command}</code>
                  {msg.sessionName && <span className="ai-popup-session-name">from {msg.sessionName}</span>}
                  <span className="ai-popup-line-count">{lineCount} lines</span>
                </div>
                {isExpanded && (
                  <pre className="ai-popup-output">{output}</pre>
                )}
              </div>
            )
          } else if (msg.type === 'error') {
            return (
              <div key={msg.id} className="ai-popup-message ai-popup-message-error">
                {msg.content}
              </div>
            )
          }
          return null
        })}
        {isLoading && (
          <div className="ai-popup-message ai-popup-message-assistant">
            <div className="ai-inline-popup-loading">
              <span></span>
              <span></span>
              <span></span>
            </div>
          </div>
        )}
        {messages.length === 0 && !isLoading && (
          <div className="ai-popup-message ai-popup-message-assistant">
            <div className="ai-popup-message-content">Analyzing...</div>
          </div>
        )}
      </div>

      {/* Suggestion to continue in panel for long conversations */}
      {messages.length >= 4 && onContinueInPanel && !isLoading && (
        <div className="ai-inline-popup-expand-hint" onClick={handleContinueInPanel}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="12" height="12">
            <polyline points="15 3 21 3 21 9" />
            <line x1="21" y1="3" x2="14" y2="10" />
          </svg>
          <span>Continue in full panel for better experience</span>
        </div>
      )}

      {/* Input for follow-up messages */}
      <form className="ai-inline-popup-input-form" onSubmit={handleSubmit}>
        <input
          ref={inputRef}
          type="text"
          className="ai-inline-popup-input"
          placeholder="Ask a follow-up question..."
          value={input}
          onChange={e => setInput(e.target.value)}
          disabled={!selectedProvider || isLoading}
        />
        {isLoading ? (
          <button type="button" className="ai-inline-popup-submit ai-stop-btn" onClick={stopAgent} title="Stop generating">
            <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14">
              <rect x="6" y="6" width="12" height="12" rx="2" />
            </svg>
          </button>
        ) : (
          <button type="submit" className="ai-inline-popup-submit" disabled={!selectedProvider || !input.trim()}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
              <line x1="22" y1="2" x2="11" y2="13" />
              <polygon points="22 2 15 22 11 13 2 9 22 2" />
            </svg>
          </button>
        )}
      </form>

      {/* Resize handle */}
      <div className="ai-inline-popup-resize-handle" onMouseDown={handleResizeStart}>
        <svg viewBox="0 0 24 24" fill="currentColor" width="10" height="10">
          <path d="M22 22H20V20H22V22ZM22 18H20V16H22V18ZM18 22H16V20H18V22ZM22 14H20V12H22V14ZM18 18H16V16H18V18ZM14 22H12V20H14V22Z" />
        </svg>
      </div>
    </div>
  )
}

export default AIInlinePopup
