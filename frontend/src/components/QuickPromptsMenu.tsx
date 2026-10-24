import { useState, useEffect, useRef, useCallback } from 'react';
import { usePopupMenuList } from '../hooks/usePopupMenuList';
import { listQuickPrompts, type QuickPrompt } from '../api/quickPrompts';
import SearchField from './SearchField';
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
  const [search, setSearch] = useState('');
  const menuRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Load on mount; failures surface as an error state with Retry.
  const { items: prompts, status, retry, onListKeyDown } = usePopupMenuList(listQuickPrompts, searchRef);

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
    <div className="quick-prompts-menu" ref={menuRef} onKeyDown={onListKeyDown}>
      <div className="quick-prompts-search">
        <SearchField inputRef={searchRef} placeholder="Search prompts..." value={search} onChange={setSearch} />
      </div>

      <div className="quick-prompts-list" role="group" aria-label="Quick prompts">
        {status === 'loading' ? (
          <div className="quick-prompts-empty" role="status">Loading...</div>
        ) : status === 'error' ? (
          <div className="quick-prompts-empty quick-prompts-error" role="alert">
            Couldn't load prompts.{' '}
            <button type="button" className="ns-btn ns-btn--ghost ns-btn--small" onClick={retry}>Retry</button>
          </div>
        ) : filteredPrompts.length === 0 ? (
          <div className="quick-prompts-empty">
            {search ? 'No prompts match your search' : 'No prompts yet'}
          </div>
        ) : (
          <>
            {favorites.length > 0 && (
              <div className="quick-prompts-section">
                {favorites.map(prompt => (
                  <button
                    type="button"
                    key={prompt.id}
                    className="quick-prompts-item"
                    data-menu-item
                    onClick={() => handleSelect(prompt)}
                  >
                    <span className="star" aria-hidden>★</span>
                    <span className="name">{prompt.name}</span>
                  </button>
                ))}
              </div>
            )}
            {others.length > 0 && (
              <div className="quick-prompts-section">
                {others.map(prompt => (
                  <button
                    type="button"
                    key={prompt.id}
                    className="quick-prompts-item"
                    data-menu-item
                    onClick={() => handleSelect(prompt)}
                  >
                    <span className="name">{prompt.name}</span>
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      <div className="quick-prompts-footer">
        <button type="button" className="ns-btn ns-btn--ghost ns-btn--small" onClick={handleManage}>
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
