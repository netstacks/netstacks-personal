import { useState, useEffect, useCallback } from 'react'
import axios from 'axios'
import { listAiMemories, createAiMemory, updateAiMemory, deleteAiMemory, type AiMemory } from '../api/ai'
import { confirmDialog } from './ConfirmDialog'

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

  const categoryBadge = (cat: string) => {
    const colors: Record<string, string> = {
      network: '#4dd0e1',
      device: '#81c784',
      procedure: '#ffa726',
      preference: '#ba68c8',
      general: '#64b5f6',
    }
    return (
      <span style={{
        fontSize: '10px',
        padding: '1px 6px',
        borderRadius: '3px',
        background: `${colors[cat] || colors.general}22`,
        color: colors[cat] || colors.general,
        fontWeight: 500,
      }}>
        {cat}
      </span>
    )
  }

  return (
    <div style={{ padding: '0 4px' }}>
      <p style={{ fontSize: '12px', color: 'var(--color-text-secondary)', marginBottom: '12px' }}>
        Facts the AI remembers across conversations. The AI can save memories automatically, or you can add them manually.
      </p>

      {/* Filter */}
      <div style={{ marginBottom: '12px', display: 'flex', gap: '8px', alignItems: 'center' }}>
        <select
          value={filterCategory}
          onChange={e => setFilterCategory(e.target.value)}
          style={{ fontSize: '12px', padding: '4px 8px', background: 'var(--color-bg-secondary)', color: 'var(--color-text-primary)', border: '1px solid var(--color-border)', borderRadius: '4px' }}
        >
          <option value="">All categories</option>
          {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <span style={{ fontSize: '11px', color: 'var(--color-text-muted)' }}>
          {memories.length} {memories.length === 1 ? 'memory' : 'memories'}
        </span>
      </div>

      {/* Add new */}
      <div style={{ display: 'flex', gap: '6px', marginBottom: '16px' }}>
        <input
          type="text"
          value={newContent}
          onChange={e => setNewContent(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleAdd()}
          placeholder="Add a memory..."
          style={{ flex: 1, fontSize: '12px', padding: '6px 8px', background: 'var(--color-bg-secondary)', color: 'var(--color-text-primary)', border: '1px solid var(--color-border)', borderRadius: '4px' }}
        />
        <select
          value={newCategory}
          onChange={e => setNewCategory(e.target.value)}
          style={{ fontSize: '12px', padding: '4px 8px', background: 'var(--color-bg-secondary)', color: 'var(--color-text-primary)', border: '1px solid var(--color-border)', borderRadius: '4px' }}
        >
          {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <button
          onClick={handleAdd}
          disabled={!newContent.trim()}
          style={{ fontSize: '12px', padding: '4px 12px', background: 'var(--color-accent)', color: 'white', border: 'none', borderRadius: '4px', cursor: newContent.trim() ? 'pointer' : 'default', opacity: newContent.trim() ? 1 : 0.5 }}
        >
          Add
        </button>
      </div>

      {/* Memory list */}
      {loading ? (
        <p style={{ fontSize: '12px', color: 'var(--color-text-muted)' }}>Loading...</p>
      ) : memories.length === 0 ? (
        <p style={{ fontSize: '12px', color: 'var(--color-text-muted)' }}>
          No memories yet. The AI will save important facts automatically during conversations, or add them manually above.
        </p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          {memories.map(m => (
            <div key={m.id} style={{
              padding: '8px 10px',
              background: 'var(--color-bg-secondary)',
              borderRadius: '4px',
              border: '1px solid var(--color-border)',
              fontSize: '12px',
            }}>
              {editingId === m.id ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  <input
                    type="text"
                    value={editContent}
                    onChange={e => setEditContent(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && handleUpdate(m.id)}
                    style={{ fontSize: '12px', padding: '4px 8px', background: 'var(--color-bg-primary)', color: 'var(--color-text-primary)', border: '1px solid var(--color-border)', borderRadius: '4px' }}
                    autoFocus
                  />
                  <div style={{ display: 'flex', gap: '6px' }}>
                    <select
                      value={editCategory}
                      onChange={e => setEditCategory(e.target.value)}
                      style={{ fontSize: '11px', padding: '2px 6px', background: 'var(--color-bg-primary)', color: 'var(--color-text-primary)', border: '1px solid var(--color-border)', borderRadius: '3px' }}
                    >
                      {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                    </select>
                    <button onClick={() => handleUpdate(m.id)} style={{ fontSize: '11px', padding: '2px 8px', background: 'var(--color-accent)', color: 'white', border: 'none', borderRadius: '3px', cursor: 'pointer' }}>Save</button>
                    <button onClick={() => setEditingId(null)} style={{ fontSize: '11px', padding: '2px 8px', background: 'transparent', color: 'var(--color-text-secondary)', border: '1px solid var(--color-border)', borderRadius: '3px', cursor: 'pointer' }}>Cancel</button>
                  </div>
                </div>
              ) : (
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '8px' }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '2px' }}>
                      {categoryBadge(m.category)}
                      {m.source === 'ai' && (
                        <span style={{ fontSize: '10px', color: 'var(--color-text-muted)' }}>auto-saved</span>
                      )}
                    </div>
                    <div style={{ color: 'var(--color-text-primary)', lineHeight: 1.4 }}>{m.content}</div>
                  </div>
                  <div style={{ display: 'flex', gap: '4px', flexShrink: 0 }}>
                    <button onClick={() => startEdit(m)} title="Edit" style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--color-text-muted)', fontSize: '12px', padding: '2px' }}>&#x270E;</button>
                    <button onClick={() => handleDelete(m.id)} title="Delete" style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--color-text-muted)', fontSize: '12px', padding: '2px' }}>&times;</button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
