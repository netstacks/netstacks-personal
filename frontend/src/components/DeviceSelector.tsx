import { useState, useEffect, useRef } from 'react';
import { useDeviceSelection } from '../hooks/useDeviceSelection';
import './DeviceSelector.css';

export type { DeviceOption } from '../hooks/useDeviceSelection';

interface DeviceSelectorProps {
  selectedIds: string[];
  onChange: (ids: string[]) => void;
}

function DeviceSelector({ selectedIds, onChange }: DeviceSelectorProps) {
  const { loading, search, setSearch, filtered, toggleDevice, toggleAll, clearAll } =
    useDeviceSelection({ selectedIds, onChange });
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on click outside
  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  return (
    <div className="device-selector" ref={ref}>
      <button
        className="device-selector-trigger"
        onClick={() => setOpen(!open)}
        type="button"
      >
        <svg className="device-selector-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="2" y="3" width="20" height="14" rx="2" />
          <line x1="8" y1="21" x2="16" y2="21" />
          <line x1="12" y1="17" x2="12" y2="21" />
        </svg>
        <span>
          {selectedIds.length > 0
            ? `${selectedIds.length} device${selectedIds.length !== 1 ? 's' : ''}`
            : 'Select devices'}
        </span>
        {selectedIds.length > 0 && (
          <span className="device-selector-badge">{selectedIds.length}</span>
        )}
        <svg className="device-selector-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <polyline points={open ? '18 15 12 9 6 15' : '6 9 12 15 18 9'} />
        </svg>
      </button>

      {open && (
        <div className="device-selector-dropdown">
          <div className="device-selector-search">
            <input
              type="search"
              placeholder="Search by name, host, or type..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              autoFocus
            />
          </div>

          <div className="device-selector-actions">
            <button type="button" onClick={toggleAll}>
              {filtered.length > 0 && filtered.every((d) => selectedIds.includes(d.id))
                ? 'Deselect all'
                : 'Select all'}
            </button>
            {selectedIds.length > 0 && (
              <button type="button" onClick={clearAll}>
                Clear
              </button>
            )}
          </div>

          <div className="device-selector-list">
            {loading && (
              <div className="device-selector-empty">Loading devices...</div>
            )}
            {!loading && filtered.length === 0 && (
              <div className="device-selector-empty">
                {search ? 'No matching devices' : 'No devices available'}
              </div>
            )}
            {!loading &&
              filtered.map((device) => (
                <label key={device.id} className="device-selector-item">
                  <input
                    type="checkbox"
                    checked={selectedIds.includes(device.id)}
                    onChange={() => toggleDevice(device.id)}
                  />
                  <div className="device-selector-info">
                    <span className="device-selector-name">{device.name}</span>
                    <span className="device-selector-host">{device.host}</span>
                  </div>
                  <span className="device-selector-type">{device.type}</span>
                </label>
              ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default DeviceSelector;
