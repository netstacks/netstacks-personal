import { useState, useEffect, useRef, useCallback } from 'react';
import { listGlobalSnippets, type GlobalSnippet } from '../api/snippets';
import './SnippetsMenu.css';

interface SnippetsMenuProps {
  onClose: () => void;
  onSelectSnippet: (snippet: GlobalSnippet) => void;
  onManageSnippets: () => void;
}

export default function SnippetsMenu({
  onClose,
  onSelectSnippet,
  onManageSnippets,
}: SnippetsMenuProps) {
  const [snippets, setSnippets] = useState<GlobalSnippet[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const menuRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Load snippets on mount
  useEffect(() => {
    listGlobalSnippets()
      .then(setSnippets)
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

  // Filter snippets by search
  const filteredSnippets = snippets.filter(s =>
    s.name.toLowerCase().includes(search.toLowerCase()) ||
    s.command.toLowerCase().includes(search.toLowerCase())
  );

  const handleSelect = useCallback((snippet: GlobalSnippet) => {
    onSelectSnippet(snippet);
    onClose();
  }, [onSelectSnippet, onClose]);

  const handleManage = useCallback(() => {
    onManageSnippets();
    onClose();
  }, [onManageSnippets, onClose]);

  return (
    <div className="snippets-menu" ref={menuRef}>
      <div className="snippets-menu-search">
        <input
          ref={searchRef}
          type="search"
          placeholder="Search snippets..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <div className="snippets-menu-list">
        {loading ? (
          <div className="snippets-menu-empty">Loading...</div>
        ) : filteredSnippets.length === 0 ? (
          <div className="snippets-menu-empty">
            {search ? 'No snippets match your search' : 'No snippets yet'}
          </div>
        ) : (
          filteredSnippets.map(snippet => (
            <div
              key={snippet.id}
              className="snippets-menu-item"
              onClick={() => handleSelect(snippet)}
            >
              <span className="snippets-menu-item-name">{snippet.name}</span>
              <span className="snippets-menu-item-command">{snippet.command}</span>
            </div>
          ))
        )}
      </div>

      <div className="snippets-menu-footer">
        <button onClick={handleManage}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
            <circle cx="12" cy="12" r="3"/>
            <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z"/>
          </svg>
          Manage Snippets...
        </button>
      </div>
    </div>
  );
}
