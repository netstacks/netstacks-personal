import { useState, useEffect, useRef, useCallback } from 'react'
import type { CliFlavor } from '../types/enrichment'
import { useAIAgent, type AgentMessage } from '../hooks/useAIAgent'
import type { TopologyAICallbacks } from '../lib/topologyAITools'
import { useAssistantName } from '../stores/assistantName'
import { fetchOllamaModels, type AiProviderType, getAiConfig } from '../api/ai'
import { resolveProvider } from '../lib/aiProviderResolver'
import type { AiContext } from '../api/ai'
import type { Document, DocumentCategory } from '../api/docs'
import MarkdownViewer from './MarkdownViewer'
import './AIFloatingChat.css'

// Session info for the agent
interface AvailableSession {
  id: string
  name: string
  connected: boolean
  cliFlavor?: string
}

interface AIFloatingChatProps {
  isOpen: boolean
  position: { x: number; y: number }
  onClose: () => void
  /** Terminal output context (last N lines of buffer) */
  terminalContext?: string
  /** Session name for context */
  sessionName?: string
  /** Session ID for running commands */
  sessionId?: string
  /** Selected/highlighted text from terminal */
  selectedText?: string
  /** Additional AI context */
  context?: AiContext
  // Session/terminal access callbacks (for full agent capability)
  availableSessions?: AvailableSession[]
  onExecuteCommand?: (sessionId: string, command: string) => Promise<string>
  getTerminalContext?: (sessionId: string, lines?: number) => Promise<string>
  // Document access callbacks
  onListDocuments?: (category?: DocumentCategory) => Promise<Document[]>
  onReadDocument?: (documentId: string, byName?: boolean) => Promise<Document | null>
  onSearchDocuments?: (query: string, category?: DocumentCategory) => Promise<Document[]>
  onSaveDocument?: (path: string, content: string, category?: DocumentCategory, mode?: 'overwrite' | 'append', sessionId?: string) => Promise<{ id: string; name: string }>
  // Topology AI tools for the active topology (Phase 27-07)
  topologyCallbacks?: TopologyAICallbacks
  allowStructuralTopologyEdits?: boolean
  /** When set, auto-send this prompt on open (contextual Ask-AI help). */
  initialPrompt?: string
  // Callback to continue conversation in full panel
  onContinueInPanel?: (messages: AgentMessage[], context?: AiContext) => void
}

const AIFloatingChat = ({
  isOpen,
  position,
  onClose,
  terminalContext: _terminalContext,
  sessionName,
  sessionId,
  selectedText,
  context,
  availableSessions,
  onExecuteCommand,
  getTerminalContext,
  onListDocuments,
  onReadDocument,
  onSearchDocuments,
  onSaveDocument,
  topologyCallbacks,
  allowStructuralTopologyEdits,
  initialPrompt,
  onContinueInPanel,
}: AIFloatingChatProps) => {
  const assistantName = useAssistantName()
  const [input, setInput] = useState('')

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
  const [pos, setPos] = useState(position)
  const [isDragging, setIsDragging] = useState(false)
  const dragOffset = useRef({ x: 0, y: 0 })

  // Resize state
  const [size, setSize] = useState({ width: 340, height: 350 })
  const [isResizing, setIsResizing] = useState(false)
  const resizeStart = useRef({ x: 0, y: 0, width: 0, height: 0 })

  const chatRef = useRef<HTMLDivElement>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Use unified AI agent hook with tools
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
    sessions: availableSessions?.map(s => ({
      id: s.id,
      name: s.name,
      connected: s.connected,
      cliFlavor: s.cliFlavor as CliFlavor | undefined,
    })),
    onExecuteCommand,
    getTerminalContext,
    // Active session — injects device memory + device/tribal context for the
    // terminal this chat was opened from.
    activeSessionId: sessionId,
    activeSessionName: sessionName,
    onListDocuments,
    onReadDocument,
    onSearchDocuments,
    onSaveDocument,
    topologyCallbacks,
    allowStructuralTopologyEdits,
  })

  const isLoading = agentState === 'thinking' || agentState === 'executing'

  // Auto-send a seeded help prompt (contextual Ask-AI). Waits for provider
  // initialization so the request uses the resolved default provider, and only
  // fires into an empty conversation. Reset on close so reopening re-asks.
  const autoSentPromptRef = useRef<string | null>(null)
  useEffect(() => {
    if (!isOpen) {
      autoSentPromptRef.current = null
      return
    }
    if (
      initialPrompt &&
      providerInitialized &&
      autoSentPromptRef.current !== initialPrompt &&
      messages.length === 0
    ) {
      autoSentPromptRef.current = initialPrompt
      sendMessage(initialPrompt)
    }
  }, [isOpen, initialPrompt, providerInitialized, messages.length, sendMessage])

  // Has content (messages or loading)
  const hasContent = messages.length > 0 || isLoading

  // Update position when prop changes (new open)
  useEffect(() => {
    if (isOpen) {
      setPos(position)
      clearMessages()
      setInput('')
      // Focus input after a short delay
      setTimeout(() => inputRef.current?.focus(), 100)
    }
  }, [isOpen, position, clearMessages])

  // Track selected text for context display (captured at open time)
  const [capturedSelectedText, setCapturedSelectedText] = useState<string | undefined>()
  useEffect(() => {
    if (isOpen) {
      setCapturedSelectedText(selectedText)
    }
  }, [isOpen, selectedText])

  // Scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

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
      const width = chatRef.current?.offsetWidth || 300
      const height = chatRef.current?.offsetHeight || 40
      setPos({
        x: Math.max(0, Math.min(window.innerWidth - width, e.clientX - dragOffset.current.x)),
        y: Math.max(0, Math.min(window.innerHeight - height, e.clientY - dragOffset.current.y))
      })
    }

    const handleMouseUp = () => setIsDragging(false)

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isDragging])

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
        width: Math.max(280, Math.min(600, resizeStart.current.width + deltaX)),
        height: Math.max(200, Math.min(600, resizeStart.current.height + deltaY)),
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

  // Handle continue in panel
  const handleContinueInPanel = useCallback(() => {
    if (onContinueInPanel) {
      onContinueInPanel(messages, context)
      onClose()
    }
  }, [messages, context, onContinueInPanel, onClose])

  const handleSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault()
    if (!input.trim() || isLoading) return

    const userMessage = input.trim()
    setInput('')

    // Include session context so AI knows which session to use
    let prompt = ''
    if (sessionId && sessionName) {
      prompt = `[Working on session: ${sessionName} (ID: ${sessionId})]\n\n`
    }
    // Include selected text as context on the first message
    if (capturedSelectedText && messages.length === 0) {
      prompt += `[Selected terminal text]\n${capturedSelectedText}\n[/Selected terminal text]\n\n`
    }
    prompt += userMessage

    sendMessage(prompt)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSubmit()
    }
  }

  // Render message content
  const renderMessage = (msg: AgentMessage) => {
    if (msg.type === 'user') {
      return <div key={msg.id} className="ai-floating-chat-message user">{msg.content}</div>
    } else if (msg.type === 'agent-thinking') {
      return (
        <div key={msg.id} className="ai-floating-chat-message assistant">
          <MarkdownViewer content={msg.content} />
        </div>
      )
    } else if (msg.type === 'command-result') {
      return (
        <div key={msg.id} className="ai-floating-chat-message command-result">
          <code className="ai-floating-chat-command">{msg.command}</code>
          <pre className="ai-floating-chat-output">{msg.output || msg.content}</pre>
        </div>
      )
    } else if (msg.type === 'error') {
      return <div key={msg.id} className="ai-floating-chat-error">{msg.content}</div>
    }
    return null
  }

  if (!isOpen) return null

  return (
    <div
      ref={chatRef}
      className={`ai-floating-chat ${isDragging ? 'dragging' : ''} ${isResizing ? 'resizing' : ''} ${hasContent ? 'expanded' : 'compact'}`}
      style={{
        left: pos.x,
        top: pos.y,
        width: hasContent ? size.width : undefined,
        height: hasContent ? size.height : undefined,
      }}
    >
      {/* Header with drag handle */}
      <div className="ai-floating-chat-header" onMouseDown={handleDragStart}>
        <div className="ai-floating-chat-drag-indicator">
          <svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12">
            <circle cx="5" cy="9" r="1.5" />
            <circle cx="12" cy="9" r="1.5" />
            <circle cx="5" cy="15" r="1.5" />
            <circle cx="12" cy="15" r="1.5" />
          </svg>
        </div>
        <span className="ai-floating-chat-title">{assistantName}</span>
        <div className="ai-floating-chat-actions" onMouseDown={e => e.stopPropagation()}>
          {onContinueInPanel && messages.length > 0 && (
            <button className="ai-floating-chat-expand" onClick={handleContinueInPanel} title="Continue in panel">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="12" height="12">
                <polyline points="15 3 21 3 21 9" />
                <polyline points="9 21 3 21 3 15" />
                <line x1="21" y1="3" x2="14" y2="10" />
                <line x1="3" y1="21" x2="10" y2="14" />
              </svg>
            </button>
          )}
          <button className="ai-floating-chat-close" onClick={onClose}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="12" height="12">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      </div>

      {/* Messages content area */}
      {hasContent && (
        <div className="ai-floating-chat-content">
          {messages.map(msg => renderMessage(msg))}
          {isLoading && (
            <div className="ai-floating-chat-message assistant">
              <div className="ai-floating-chat-loading">
                <span></span><span></span><span></span>
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>
      )}

      {/* Suggestion to continue in panel for long conversations */}
      {messages.length >= 4 && onContinueInPanel && !isLoading && (
        <div className="ai-floating-chat-expand-hint" onClick={handleContinueInPanel}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="12" height="12">
            <polyline points="15 3 21 3 21 9" />
            <line x1="21" y1="3" x2="14" y2="10" />
          </svg>
          <span>Continue in full panel for better experience</span>
        </div>
      )}

      {/* Selected text context indicator */}
      {capturedSelectedText && messages.length === 0 && (
        <div className="ai-floating-chat-context-indicator">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="12" height="12">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
          </svg>
          <span className="ai-floating-chat-context-text">
            {capturedSelectedText.length > 80
              ? capturedSelectedText.substring(0, 80) + '...'
              : capturedSelectedText}
          </span>
        </div>
      )}

      {/* Input row */}
      <div className="ai-floating-chat-input-row">
        <form className="ai-floating-chat-input-form" onSubmit={handleSubmit}>
          <input
            ref={inputRef}
            type="text"
            className="ai-floating-chat-input"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={sessionName ? `Ask about ${sessionName}...` : 'Ask AI...'}
            disabled={!selectedProvider || isLoading}
          />
          {isLoading ? (
            <button
              type="button"
              className="ai-floating-chat-send ai-stop-btn"
              onClick={stopAgent}
              title="Stop generating"
            >
              <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14">
                <rect x="6" y="6" width="12" height="12" rx="2" />
              </svg>
            </button>
          ) : (
            <button
              type="submit"
              className="ai-floating-chat-send"
              disabled={!selectedProvider || !input.trim()}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
                <line x1="22" y1="2" x2="11" y2="13" />
                <polygon points="22 2 15 22 11 13 2 9 22 2" />
              </svg>
            </button>
          )}
        </form>
      </div>

      {/* Resize handle */}
      {hasContent && (
        <div className="ai-floating-chat-resize-handle" onMouseDown={handleResizeStart}>
          <svg viewBox="0 0 24 24" fill="currentColor" width="10" height="10">
            <path d="M22 22H20V20H22V22ZM22 18H20V16H22V18ZM18 22H16V20H18V22ZM22 14H20V12H22V14ZM18 18H16V16H18V18ZM14 22H12V20H14V22Z" />
          </svg>
        </div>
      )}
    </div>
  )
}

export default AIFloatingChat
