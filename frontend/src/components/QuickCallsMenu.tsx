import { useState, useEffect, useRef, useCallback } from 'react';
import { listQuickActions, type QuickAction } from '../api/quickActions';
import './QuickCallsMenu.css';

interface QuickCallsMenuProps {
  onClose: () => void;
  onSelectCall: (call: QuickAction) => void;
  onManageQuickCalls: () => void;
}

export default function QuickCallsMenu({
  onClose,
  onSelectCall,
  onManageQuickCalls,
}: QuickCallsMenuProps) {
  const [calls, setCalls] = useState<QuickAction[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const menuRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Load quick calls on mount
  useEffect(() => {
    listQuickActions()
      .then(setCalls)
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

  // Filter calls by search
  const filteredCalls = calls.filter(c =>
    c.name.toLowerCase().includes(search.toLowerCase()) ||
    (c.description && c.description.toLowerCase().includes(search.toLowerCase()))
  );

  const handleSelect = useCallback((call: QuickAction) => {
    onSelectCall(call);
    onClose();
  }, [onSelectCall, onClose]);

  const handleManage = useCallback(() => {
    onManageQuickCalls();
    onClose();
  }, [onManageQuickCalls, onClose]);

  return (
    <div className="quick-calls-menu" ref={menuRef}>
      <div className="quick-calls-search">
        <input
          ref={searchRef}
          type="search"
          placeholder="Search quick calls..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <div className="quick-calls-list">
        {loading ? (
          <div className="quick-calls-empty">Loading...</div>
        ) : filteredCalls.length === 0 ? (
          <div className="quick-calls-empty">
            {search ? 'No calls match your search' : 'No quick calls yet — add some in Settings'}
          </div>
        ) : (
          filteredCalls.map(call => (
            <div
              key={call.id}
              className="quick-calls-item"
              onClick={() => handleSelect(call)}
            >
              <span className="name">{call.name}</span>
              {call.description && (
                <span className="description">{call.description}</span>
              )}
            </div>
          ))
        )}
      </div>

      <div className="quick-calls-footer">
        <button onClick={handleManage}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
            <circle cx="12" cy="12" r="3"/>
            <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z"/>
          </svg>
          Manage Quick Calls...
        </button>
      </div>
    </div>
  );
}
