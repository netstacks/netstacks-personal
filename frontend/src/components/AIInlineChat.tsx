import { useState, useEffect, useRef, useCallback } from 'react'
import './AIInlineChat.css'
import { useAssistantName } from '../stores/assistantName'
import type { CliFlavor } from '../types/enrichment'
import { useAIAgent } from '../hooks/useAIAgent'
import { fetchOllamaModels, type AiProviderType, getAiConfig } from '../api/ai'
import { resolveProvider } from '../lib/aiProviderResolver'
import type { AiContext } from '../api/ai'
import type { Document, DocumentCategory } from '../api/docs'
import AIContextSummary from './AIContextSummary'

// Available session info for the agent
interface AvailableSession {
  id: string
  name: string
  connected: boolean
  cliFlavor?: string
}

interface AIInlineChatProps {
  isOpen: boolean
  onClose: () => void
  onSubmit?: (message: string) => void
  selectedText?: string
  context?: AiContext
  // Session/terminal access callbacks (for full agent capability)
  availableSessions?: AvailableSession[]
  onExecuteCommand?: (sessionId: string, command: string) => Promise<string>
  getTerminalContext?: (sessionId: string, lines?: number) => Promise<string>
  // Document access callbacks
  onListDocuments?: (category?: DocumentCategory) => Promise<Document[]>
  onReadDocument?: (documentId: string) => Promise<Document | null>
  onSearchDocuments?: (query: string, category?: DocumentCategory) => Promise<Document[]>
}

const AIInlineChat = ({
  isOpen,
  onClose,
  onSubmit,
  selectedText,
  context,
  availableSessions,
  onExecuteCommand,
  getTerminalContext,
  onListDocuments,
  onReadDocument,
  onSearchDocuments,
}: AIInlineChatProps) => {
  const assistantName = useAssistantName()
  const [input, setInput] = useState('')
  const [greeting, setGreeting] = useState<string>('')
  const inputRef = useRef<HTMLInputElement>(null)
  const messagesRef = useRef<HTMLDivElement>(null)

  // Provider/Model state (initialized from settings)
  const [selectedProvider, setSelectedProvider] = useState<AiProviderType>('ollama')
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

  // Use unified AI agent hook with ALL tools
  const {
    messages,
    agentState,
    sendMessage,
    stopAgent,
    clearMessages,
  } = useAIAgent({
    permissionMode: 'auto',
    provider: selectedProvider,
    model: selectedModel,
    // Session/terminal tools
    sessions: availableSessions?.map(s => ({
      id: s.id,
      name: s.name,
      connected: s.connected,
      cliFlavor: s.cliFlavor as CliFlavor | undefined,
    })),
    onExecuteCommand,
    getTerminalContext,
    // Document tools
    onListDocuments,
    onReadDocument,
    onSearchDocuments,
  })

  // Build context-aware greeting when opening
  useEffect(() => {
    if (isOpen && messages.length === 0) {
      // Build initial context message based on what's available
      let contextMessage = ''

      if (selectedText) {
        contextMessage = `I see you've selected: "${selectedText.substring(0, 100)}${selectedText.length > 100 ? '...' : ''}"\n\nHow can I help you with this?`
      } else if (context?.device) {
        contextMessage = `I'm looking at ${context.device.name} (${context.device.vendor || context.device.type}${context.device.primaryIp ? `, ${context.device.primaryIp}` : ''}).\n\nHow can I help you with this device?`
      } else if (context?.connection) {
        contextMessage = `I can see the link between ${context.connection.sourceDevice.name} (${context.connection.sourceInterface}) and ${context.connection.targetDevice.name} (${context.connection.targetInterface}).\n\nHow can I help you with this connection?`
      } else if (context?.terminal?.recentOutput) {
        contextMessage = `I can see your recent terminal output. How can I help you with what you're working on?`
      } else if (context?.sessionName) {
        contextMessage = `Connected to ${context.sessionName}. How can I help?`
      }

      setGreeting(contextMessage)
    }
  }, [isOpen, selectedText, context, messages.length])

  // Focus input when opened
  useEffect(() => {
    if (isOpen && inputRef.current) {
      inputRef.current.focus()
    }
  }, [isOpen])

  // Scroll to bottom on new messages
  useEffect(() => {
    if (messagesRef.current) {
      messagesRef.current.scrollTop = messagesRef.current.scrollHeight
    }
  }, [messages])

  // Close on Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
      }
    }

    if (isOpen) {
      document.addEventListener('keydown', handleKeyDown)
      return () => document.removeEventListener('keydown', handleKeyDown)
    }
  }, [isOpen, onClose])

  // Clear messages when modal closes
  useEffect(() => {
    if (!isOpen) {
      clearMessages()
      setGreeting('')
      setInput('')
    }
  }, [isOpen, clearMessages])

  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault()
    if (!input.trim() || agentState !== 'idle') return

    const userMessage = input.trim()
    setInput('')

    // Send message via agent hook
    await sendMessage(userMessage)

    onSubmit?.(userMessage)
  }, [input, agentState, sendMessage, onSubmit])

  const handleClear = useCallback(() => {
    clearMessages()
    setInput('')
    setGreeting('')
  }, [clearMessages])

  if (!isOpen) return null

  return (
    <div className="ai-inline-chat-overlay" onClick={onClose}>
      <div className="ai-inline-chat" onClick={e => e.stopPropagation()}>
        <div className="ai-inline-chat-header">
          <div className="ai-inline-chat-title">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M12 2L2 7l10 5 10-5-10-5z" />
              <path d="M2 17l10 5 10-5" />
              <path d="M2 12l10 5 10-5" />
            </svg>
            <span>{assistantName}</span>
            <kbd>Cmd+I</kbd>
          </div>
          <div className="ai-inline-chat-actions">
            {messages.length > 0 && (
              <button className="ai-inline-chat-clear" onClick={handleClear} title="Clear chat">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                </svg>
              </button>
            )}
            <button className="ai-inline-chat-close" onClick={onClose} title="Close (Esc)">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </div>

        {/* Context summary for current chat */}
        <div className="ai-inline-chat-context">
          <AIContextSummary context={{ ...context, selectedText: selectedText || context?.selectedText }} />
        </div>

        {(greeting || messages.length > 0) && (
          <div className="ai-inline-chat-messages" ref={messagesRef}>
            {/* Show greeting if no messages yet */}
            {greeting && messages.length === 0 && (
              <div className="ai-chat-message ai-chat-message-assistant">
                <div className="ai-chat-message-content">{greeting}</div>
              </div>
            )}
            {/* Render agent messages */}
            {messages.map((msg) => {
              // Map agent message types to CSS classes
              const roleClass = msg.type === 'user' ? 'user'
                : msg.type === 'error' ? 'error'
                : 'assistant'

              return (
                <div key={msg.id} className={`ai-chat-message ai-chat-message-${roleClass}`}>
                  <div className="ai-chat-message-content">
                    {msg.type === 'error' ? (
                      <span className="ai-chat-error">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
                          <circle cx="12" cy="12" r="10" />
                          <line x1="12" y1="8" x2="12" y2="12" />
                          <line x1="12" y1="16" x2="12.01" y2="16" />
                        </svg>
                        {msg.content}
                      </span>
                    ) : msg.type === 'command-result' ? (
                      <div className="ai-chat-command-result">
                        <code className="ai-chat-command">{msg.command}</code>
                        <pre className="ai-chat-output">{msg.output || msg.content}</pre>
                      </div>
                    ) : (
                      msg.content
                    )}
                  </div>
                </div>
              )
            })}
            {/* Show loading indicator while agent is thinking/executing */}
            {(agentState === 'thinking' || agentState === 'executing') && (
              <div className="ai-chat-message ai-chat-message-assistant">
                <div className="ai-chat-message-content ai-chat-loading">
                  <span></span>
                  <span></span>
                  <span></span>
                </div>
              </div>
            )}
          </div>
        )}

        <form className="ai-inline-chat-input-form" onSubmit={handleSubmit}>
          <input
            ref={inputRef}
            type="text"
            className="ai-inline-chat-input"
            placeholder="Ask AI anything... (explain, fix, suggest)"
            value={input}
            onChange={e => setInput(e.target.value)}
            disabled={agentState === 'thinking' || agentState === 'executing'}
          />
          {agentState === 'thinking' || agentState === 'executing' ? (
            <button type="button" className="ai-inline-chat-submit ai-stop-btn" onClick={stopAgent} title="Stop generating">
              <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16">
                <rect x="6" y="6" width="12" height="12" rx="2" />
              </svg>
            </button>
          ) : (
            <button type="submit" className="ai-inline-chat-submit" disabled={!input.trim()}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="22" y1="2" x2="11" y2="13" />
                <polygon points="22 2 15 22 11 13 2 9 22 2" />
              </svg>
            </button>
          )}
        </form>
      </div>
    </div>
  )
}

export default AIInlineChat
