import { useState, useEffect, useRef, useCallback } from 'react';
import { listQuickPrompts, type QuickPrompt } from '../api/quickPrompts';
import './QuickPromptsMenu.css';

interface QuickPromptsMenuProps {
  onClose: () => void;
  onSelectPrompt: (prompt: QuickPrompt) => void;
  onManagePrompts: () => void;
}

export default function QuickPromptsMenu({
  onClose,
  onSelectPrompt,
  onManagePrompts,
}: QuickPromptsMenuProps) {
  const [prompts, setPrompts] = useState<QuickPrompt[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const menuRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Load prompts on mount
  useEffect(() => {
    listQuickPrompts()
      .then(setPrompts)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  // Focus search on mount
  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  // Close on click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [onClose]);

  // Close on Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  // Filter prompts by search
  const filteredPrompts = prompts.filter(p =>
    p.name.toLowerCase().includes(search.toLowerCase()) ||
    p.prompt.toLowerCase().includes(search.toLowerCase())
  );

  const favorites = filteredPrompts.filter(p => p.is_favorite);
  const others = filteredPrompts.filter(p => !p.is_favorite);

  const handleSelect = useCallback((prompt: QuickPrompt) => {
    onSelectPrompt(prompt);
    onClose();
  }, [onSelectPrompt, onClose]);

  const handleManage = useCallback(() => {
    onManagePrompts();
    onClose();
  }, [onManagePrompts, onClose]);

  return (
    <div className="quick-prompts-menu" ref={menuRef}>
      <div className="quick-prompts-search">
        <input
          ref={searchRef}
          type="text"
          placeholder="Search prompts..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <div className="quick-prompts-list">
        {loading ? (
          <div className="quick-prompts-empty">Loading...</div>
        ) : filteredPrompts.length === 0 ? (
          <div className="quick-prompts-empty">
            {search ? 'No prompts match your search' : 'No prompts yet'}
          </div>
        ) : (
          <>
            {favorites.length > 0 && (
              <div className="quick-prompts-section">
                {favorites.map(prompt => (
                  <div
                    key={prompt.id}
                    className="quick-prompts-item"
                    onClick={() => handleSelect(prompt)}
                  >
                    <span className="star">★</span>
                    <span className="name">{prompt.name}</span>
                  </div>
                ))}
              </div>
            )}
            {others.length > 0 && (
              <div className="quick-prompts-section">
                {others.map(prompt => (
                  <div
                    key={prompt.id}
                    className="quick-prompts-item"
                    onClick={() => handleSelect(prompt)}
                  >
                    <span className="name">{prompt.name}</span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      <div className="quick-prompts-footer">
        <button onClick={handleManage}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
            <circle cx="12" cy="12" r="3"/>
            <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z"/>
          </svg>
          Manage Prompts...
        </button>
      </div>
    </div>
  );
}
