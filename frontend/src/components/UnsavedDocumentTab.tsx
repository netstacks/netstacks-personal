import { useState, useCallback } from 'react'
import type { DocumentCategory, ContentType } from '../api/docs'
import JsonViewer from './JsonViewer'
import './UnsavedDocumentTab.css'

interface UnsavedDoc {
  name: string
  content: string
  contentType: ContentType
  category: DocumentCategory
}

interface UnsavedDocumentTabProps {
  tabId: string
  unsavedDoc: UnsavedDoc
  onSave: (tabId: string, name: string, category: DocumentCategory, contentType: ContentType, content: string) => Promise<void>
}

const CATEGORIES: { value: DocumentCategory; label: string }[] = [
  { value: 'outputs', label: 'Outputs' },
  { value: 'templates', label: 'Templates' },
  { value: 'notes', label: 'Notes' },
  { value: 'backups', label: 'Backups' },
]

export default function UnsavedDocumentTab({ tabId, unsavedDoc, onSave }: UnsavedDocumentTabProps) {
  const [name, setName] = useState(unsavedDoc.name)
  const [category, setCategory] = useState<DocumentCategory>(unsavedDoc.category)
  const [saving, setSaving] = useState(false)

  const handleSave = useCallback(async () => {
    if (!name.trim() || saving) return
    setSaving(true)
    try {
      await onSave(tabId, name.trim(), category, unsavedDoc.contentType, unsavedDoc.content)
    } finally {
      setSaving(false)
    }
  }, [tabId, name, category, unsavedDoc, onSave, saving])

  return (
    <div className="unsaved-doc-tab">
      <div className="unsaved-doc-save-bar">
        <div className="unsaved-doc-badge">Unsaved</div>
        <input
          className="unsaved-doc-name-input"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Document name"
          onKeyDown={(e) => { if (e.key === 'Enter') handleSave() }}
        />
        <select
          className="unsaved-doc-category-select"
          value={category}
          onChange={(e) => setCategory(e.target.value as DocumentCategory)}
        >
          {CATEGORIES.map(c => (
            <option key={c.value} value={c.value}>{c.label}</option>
          ))}
        </select>
        <button
          className="unsaved-doc-save-btn"
          onClick={handleSave}
          disabled={!name.trim() || saving}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
            <path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z" />
            <polyline points="17 21 17 13 7 13 7 21" />
            <polyline points="7 3 7 8 15 8" />
          </svg>
          {saving ? 'Saving...' : 'Save to Docs'}
        </button>
      </div>
      <div className="unsaved-doc-content">
        {unsavedDoc.contentType === 'json' ? (
          <JsonViewer content={unsavedDoc.content} />
        ) : (
          <pre className="unsaved-doc-pre">{unsavedDoc.content}</pre>
        )}
      </div>
    </div>
  )
}
