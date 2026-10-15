import AITabInput from './AITabInput'
import { useState, useEffect, useCallback } from 'react'
import axios from 'axios'
import { listAiMemories, createAiMemory, updateAiMemory, deleteAiMemory, type AiMemory } from '../api/ai'
import { confirmDialog } from './ConfirmDialog'
import SettingsSection from './settings/SettingsSection'
import SettingsItem from './settings/SettingsItem'
import './AIMemoryTab.css'

const CATEGORIES = ['general', 'network', 'device', 'procedure', 'preference'] as const

export default function AIMemoryTab() {
  const [memories, setMemories] = useState<AiMemory[]>([])
  const [loading, setLoading] = useState(true)
  const [newContent, setNewContent] = useState('')
  const [newCategory, setNewCategory] = useState<string>('general')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editContent, setEditContent] = useState('')
  const [editCategory, setEditCategory] = useState<string>('general')
  const [filterCategory, setFilterCategory] = useState<string>('')

  const loadMemories = useCallback(async () => {
    try {
      const data = await listAiMemories(filterCategory || undefined)
      setMemories(data)
    } catch (err) {
      // Silently handle 404s (route may not exist on this backend)
      if (axios.isAxiosError(err) && err.response?.status === 404) {
        setMemories([])
      } else {
        console.error('Failed to load memories:', err)
      }
    } finally {
      setLoading(false)
    }
  }, [filterCategory])

  useEffect(() => { loadMemories() }, [loadMemories])

  const handleAdd = async () => {
    if (!newContent.trim()) return
    try {
      await createAiMemory(newContent.trim(), newCategory)
      setNewContent('')
      setNewCategory('general')
      loadMemories()
    } catch (err) {
      console.error('Failed to create memory:', err)
    }
  }

  const handleUpdate = async (id: string) => {
    if (!editContent.trim()) return
    try {
      await updateAiMemory(id, editContent.trim(), editCategory)
      setEditingId(null)
      loadMemories()
    } catch (err) {
      console.error('Failed to update memory:', err)
    }
  }

  const handleDelete = async (id: string) => {
    const ok = await confirmDialog({
      title: 'Delete memory?',
      body: 'Delete this AI memory entry? It will no longer be sent as context.',
      confirmLabel: 'Delete',
      destructive: true,
    })
    if (!ok) return
    try {
      await deleteAiMemory(id)
      loadMemories()
    } catch (err) {
      console.error('Failed to delete memory:', err)
    }
  }

  const startEdit = (memory: AiMemory) => {
    setEditingId(memory.id)
    setEditContent(memory.content)
    setEditCategory(memory.category)
  }


  return (
    <SettingsSection
      title="AI Memory"
      description="Facts the AI remembers across conversations. The AI saves memories automatically, or you can add them here."
      actions={
        <select aria-label="Filter by category"
          value={filterCategory}
          onChange={e => setFilterCategory(e.target.value)}
          className="ns-select"
        >
          <option value="">All categories</option>
          {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
      }
    >
      <div className="settings-group">
        <div className="ai-memory-add">
          <AITabInput
            aria-label="New memory"
            value={newContent}
            onChange={e => setNewContent(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleAdd()}
            placeholder="Add a memory..."
            aiField="AI memory"
            aiPlaceholder="A durable fact about the user's network or preferences for the AI to remember"
            aiContext={{ category: newCategory }}
            onAIValue={setNewContent}
          />
          <select aria-label="Category"
            value={newCategory}
            onChange={e => setNewCategory(e.target.value)}
            className="ns-select"
          >
            {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          <button onClick={handleAdd} disabled={!newContent.trim()} className="ns-btn ns-btn--small">
            Add
          </button>
        </div>
        {memories.map(m => (
          <SettingsItem
            key={m.id}
            title={editingId === m.id ? (
              <AITabInput aria-label="Memory"
                value={editContent}
                onChange={e => setEditContent(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleUpdate(m.id)}
                aiField="AI memory"
                aiPlaceholder="A durable fact about the user's network or preferences for the AI to remember"
                aiContext={{ category: m.category }}
                onAIValue={setEditContent}
                autoFocus
              />
            ) : m.content}
            meta={
              editingId === m.id ? (
                <select aria-label="Category"
                  value={editCategory}
                  onChange={e => setEditCategory(e.target.value)}
                  className="ns-select"
                >
                  {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              ) : (
                <>
                  <span className="settings-badge">{m.category}</span>
                  {m.source === 'ai' && <span>auto-saved</span>}
                </>
              )
            }
            actions={editingId === m.id ? (
              <>
                <button className="ns-btn ns-btn--small ns-btn--ghost" onClick={() => setEditingId(null)}>Cancel</button>
                <button className="ns-btn ns-btn--small ns-btn--primary" onClick={() => handleUpdate(m.id)}>Save</button>
              </>
            ) : (
              <>
                <button className="ns-btn ns-btn--small ns-btn--ghost" onClick={() => startEdit(m)}>Edit</button>
                <button className="ns-btn ns-btn--small ns-btn--ghost ns-btn--danger" onClick={() => handleDelete(m.id)}>Delete</button>
              </>
            )}
          />
        ))}
      </div>
      {loading ? (
        <p className="form-hint">Loading…</p>
      ) : memories.length === 0 ? (
        <p className="form-hint">No memories yet. The AI saves important facts automatically during conversations, or add them above.</p>
      ) : (
        <p className="form-hint">{memories.length} {memories.length === 1 ? 'memory' : 'memories'}</p>
      )}
    </SettingsSection>
  )
}
