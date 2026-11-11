/**
 * useDropdown - Custom hook for managing dropdown state with click-outside handling
 *
 * Consolidates the common pattern of:
 * - useState for visibility
 * - useRef for the dropdown container
 * - useEffect for click-outside detection
 *
 * Usage:
 *   const { isOpen, toggle, close, ref } = useDropdown();
 *   <div ref={ref}>
 *     <button onClick={toggle}>Open</button>
 *     {isOpen && <div>Content</div>}
 *   </div>
 */

import { useState, useRef, useEffect, useCallback } from 'react';

interface UseDropdownReturn {
  /** Whether the dropdown is currently open */
  isOpen: boolean;
  /** Toggle the dropdown open/closed */
  toggle: () => void;
  /** Close the dropdown */
  close: () => void;
  /** Open the dropdown */
  open: () => void;
  /** Ref to attach to the dropdown container element */
  ref: React.RefObject<HTMLDivElement | null>;
}

/**
 * Hook for managing a single dropdown with click-outside handling.
 *
 * @returns Object with isOpen state, toggle/close/open functions, and container ref
 */
export function useDropdown(): UseDropdownReturn {
  const [isOpen, setIsOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const toggle = useCallback(() => setIsOpen(prev => !prev), []);
  const close = useCallback(() => setIsOpen(false), []);
  const open = useCallback(() => setIsOpen(true), []);

  useEffect(() => {
    if (!isOpen) return;

    function handleClickOutside(event: MouseEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  return { isOpen, toggle, close, open, ref };
}

interface UseMultipleDropdownsReturn<K extends string> {
  /** Check if a specific dropdown is open */
  isOpen: (key: K) => boolean;
  /** Toggle a specific dropdown */
  toggle: (key: K) => void;
  /** Close a specific dropdown */
  close: (key: K) => void;
  /** Close all dropdowns */
  closeAll: () => void;
  /** Get ref for a specific dropdown */
  getRef: (key: K) => React.RefObject<HTMLDivElement | null>;
}

/**
 * Hook for managing multiple dropdowns that share click-outside handling.
 * Only one dropdown can be open at a time.
 *
 * @param keys - Array of dropdown identifiers
 * @returns Object with functions to manage dropdowns by key
 */
export function useMultipleDropdowns<K extends string>(keys: readonly K[]): UseMultipleDropdownsReturn<K> {
  const [openKey, setOpenKey] = useState<K | null>(null);
  const refs = useRef<Map<K, React.RefObject<HTMLDivElement | null>>>(new Map());

  // Initialize refs for each key
  for (const key of keys) {
    if (!refs.current.has(key)) {
      refs.current.set(key, { current: null });
    }
  }

  const isOpen = useCallback((key: K) => openKey === key, [openKey]);

  const toggle = useCallback((key: K) => {
    setOpenKey(prev => prev === key ? null : key);
  }, []);

  const close = useCallback((key: K) => {
    setOpenKey(prev => prev === key ? null : prev);
  }, []);

  const closeAll = useCallback(() => setOpenKey(null), []);

  const getRef = useCallback((key: K): React.RefObject<HTMLDivElement | null> => {
    let ref = refs.current.get(key);
    if (!ref) {
      ref = { current: null };
      refs.current.set(key, ref);
    }
    return ref;
  }, []);

  // Click-outside handler for all dropdowns
  useEffect(() => {
    if (openKey === null) return;

    function handleClickOutside(event: MouseEvent) {
      const target = event.target as Node;
      // Capture openKey value for the closure
      const currentOpenKey = openKey;
      if (currentOpenKey === null) return;
      const openRef = refs.current.get(currentOpenKey);
      if (openRef?.current && !openRef.current.contains(target)) {
        setOpenKey(null);
      }
    }

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [openKey]);

  return { isOpen, toggle, close, closeAll, getRef };
}
