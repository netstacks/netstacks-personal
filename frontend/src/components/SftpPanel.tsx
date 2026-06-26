import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useClampedMenuPosition } from '../hooks/useClampedMenuPosition';
import {
  sftpLs,
  sftpDownload,
  sftpUpload,
  sftpMkdir,
  sftpRm,
  sftpRename,
  formatFileSize,
  type FileEntry,
} from '../api/sftp';
import { downloadFile } from '../lib/formatters';
import { isTextFile } from '../lib/sftpStartPaths';
import { useSftpStore } from '../stores/sftpStore';
import { useTauriDragDrop } from '../lib/tauriDragDrop';
import TransferProgress, { type TransferItem } from './TransferProgress';
import './SftpPanel.css';

// --- Icons ---

import { getErrorMessage } from '../api/errors'
const FolderIcon = () => (
  <svg viewBox="0 0 16 16" fill="currentColor">
    <path d="M14.5 3H7.71l-.85-.85A.5.5 0 006.5 2h-5a.5.5 0 00-.5.5v11a.5.5 0 00.5.5h13a.5.5 0 00.5-.5v-10a.5.5 0 00-.5-.5z" />
  </svg>
);

const FileIcon = () => (
  <svg viewBox="0 0 16 16" fill="currentColor">
    <path d="M4 0a2 2 0 00-2 2v12a2 2 0 002 2h8a2 2 0 002-2V4.5L9.5 0H4zm5.5 1v3.5H13v9.5a1 1 0 01-1 1H4a1 1 0 01-1-1V2a1 1 0 011-1h5.5z" />
  </svg>
);

const ChevronIcon = () => (
  <svg viewBox="0 0 16 16" fill="currentColor">
    <path d="M6.22 3.22a.75.75 0 011.06 0l4.25 4.25a.75.75 0 010 1.06l-4.25 4.25a.75.75 0 01-1.06-1.06L9.94 8 6.22 4.28a.75.75 0 010-1.06z" />
  </svg>
);

const RefreshIcon = () => (
  <svg viewBox="0 0 16 16" fill="currentColor">
    <path d="M11.534 7h3.932a.25.25 0 01.192.41l-1.966 2.36a.25.25 0 01-.384 0l-1.966-2.36a.25.25 0 01.192-.41zm-11 2h3.932a.25.25 0 00.192-.41L2.692 6.23a.25.25 0 00-.384 0L.342 8.59A.25.25 0 00.534 9z" />
    <path d="M8 3c-1.552 0-2.94.707-3.857 1.818a.5.5 0 11-.77-.636A6 6 0 0114 8a.5.5 0 01-1 0 5 5 0 00-5-5zM2.5 8a.5.5 0 01.5.5A5 5 0 008 13c1.552 0 2.94-.707 3.857-1.818a.5.5 0 11.77.636A6 6 0 012 8.5a.5.5 0 01.5-.5z" />
  </svg>
);

const UploadIcon = () => (
  <svg viewBox="0 0 16 16" fill="currentColor">
    <path d="M.5 9.9a.5.5 0 01.5.5v2.5a1 1 0 001 1h12a1 1 0 001-1v-2.5a.5.5 0 011 0v2.5a2 2 0 01-2 2H2a2 2 0 01-2-2v-2.5a.5.5 0 01.5-.5z" />
    <path d="M7.646 1.146a.5.5 0 01.708 0l3 3a.5.5 0 01-.708.708L8.5 2.707V11.5a.5.5 0 01-1 0V2.707L5.354 4.854a.5.5 0 11-.708-.708l3-3z" />
  </svg>
);

const DownloadIcon = () => (
  <svg viewBox="0 0 16 16" fill="currentColor">
    <path d="M.5 9.9a.5.5 0 01.5.5v2.5a1 1 0 001 1h12a1 1 0 001-1v-2.5a.5.5 0 011 0v2.5a2 2 0 01-2 2H2a2 2 0 01-2-2v-2.5a.5.5 0 01.5-.5z" />
    <path d="M7.646 11.854a.5.5 0 00.708 0l3-3a.5.5 0 00-.708-.708L8.5 10.293V1.5a.5.5 0 00-1 0v8.793L5.354 8.146a.5.5 0 10-.708.708l3 3z" />
  </svg>
);

const NewFolderIcon = () => (
  <svg viewBox="0 0 16 16" fill="currentColor">
    <path d="M11 6.5a.5.5 0 01.5-.5h2a.5.5 0 01.5.5v2a.5.5 0 01-.5.5h-2a.5.5 0 01-.5-.5v-2z" />
    <path d="M1.5 1a.5.5 0 00-.5.5v12a.5.5 0 00.5.5h13a.5.5 0 00.5-.5V3a.5.5 0 00-.5-.5H7.71l-.85-.85A.5.5 0 006.5 1h-5zm5.293 1H6.5a.5.5 0 01.354.146L8.207 3.5H13.5v10H2V2.5h4.293z" />
  </svg>
);

const TrashIcon = () => (
  <svg viewBox="0 0 16 16" fill="currentColor">
    <path d="M5.5 5.5A.5.5 0 016 6v6a.5.5 0 01-1 0V6a.5.5 0 01.5-.5zm2.5 0a.5.5 0 01.5.5v6a.5.5 0 01-1 0V6a.5.5 0 01.5-.5zm3 .5a.5.5 0 00-1 0v6a.5.5 0 001 0V6z" />
    <path d="M14.5 3a1 1 0 01-1 1H13v9a2 2 0 01-2 2H5a2 2 0 01-2-2V4h-.5a1 1 0 01-1-1V2a1 1 0 011-1H6a1 1 0 011-1h2a1 1 0 011 1h3.5a1 1 0 011 1v1zM4.118 4L4 4.059V13a1 1 0 001 1h6a1 1 0 001-1V4.059L11.882 4H4.118zM2.5 3V2h11v1h-11z" />
  </svg>
);

const EditIcon = () => (
  <svg viewBox="0 0 16 16" fill="currentColor">
    <path d="M12.146.146a.5.5 0 01.708 0l3 3a.5.5 0 010 .708l-10 10a.5.5 0 01-.168.11l-5 2a.5.5 0 01-.65-.65l2-5a.5.5 0 01.11-.168l10-10zM11.207 2.5L13.5 4.793 14.793 3.5 12.5 1.207 11.207 2.5zm1.586 3L10.5 3.207 4 9.707V10h.5a.5.5 0 01.5.5v.5h.5a.5.5 0 01.5.5v.5h.293l6.5-6.5zm-9.761 5.175l-.106.106-1.528 3.821 3.821-1.528.106-.106A.5.5 0 015 12.5V12h-.5a.5.5 0 01-.5-.5V11h-.5a.5.5 0 01-.468-.325z" />
  </svg>
);

const CloseIcon = () => (
  <svg viewBox="0 0 16 16" fill="currentColor">
    <path d="M4.646 4.646a.5.5 0 01.708 0L8 7.293l2.646-2.647a.5.5 0 01.708.708L8.707 8l2.647 2.646a.5.5 0 01-.708.708L8 8.707l-2.646 2.647a.5.5 0 01-.708-.708L7.293 8 4.646 5.354a.5.5 0 010-.708z" />
  </svg>
);

const CopyIcon = () => (
  <svg viewBox="0 0 16 16" fill="currentColor">
    <path d="M4 1.5H3a2 2 0 00-2 2V14a2 2 0 002 2h10a2 2 0 002-2V3.5a2 2 0 00-2-2h-1v1h1a1 1 0 011 1V14a1 1 0 01-1 1H3a1 1 0 01-1-1V3.5a1 1 0 011-1h1v-1z" />
    <path d="M9.5 1a.5.5 0 01.5.5v1a.5.5 0 01-.5.5h-3a.5.5 0 01-.5-.5v-1a.5.5 0 01.5-.5h3z" />
  </svg>
);

const OpenFileIcon = () => (
  <svg viewBox="0 0 16 16" fill="currentColor">
    <path d="M5.884 6.68a.5.5 0 10-.768.64L7.349 10l-2.233 2.68a.5.5 0 00.768.64L8 10.781l2.116 2.54a.5.5 0 00.768-.641L8.651 10l2.233-2.68a.5.5 0 00-.768-.64L8 9.219l-2.116-2.54z" />
    <path d="M14 14V4.5L9.5 0H4a2 2 0 00-2 2v12a2 2 0 002 2h8a2 2 0 002-2zM9.5 3A1.5 1.5 0 0011 4.5h2V14a1 1 0 01-1 1H4a1 1 0 01-1-1V2a1 1 0 011-1h5.5v2z" />
  </svg>
);

// --- Types ---

interface SftpPanelProps {
  onOpenFile: (connectionId: string, filePath: string, fileName: string, deviceName: string) => void;
}

interface ContextMenuState {
  x: number;
  y: number;
  entry: FileEntry | null;
  parentPath: string;
}

// --- Helpers ---

function sortEntries(entries: FileEntry[]): FileEntry[] {
  return [...entries].sort((a, b) => {
    if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
}

function getParentPath(path: string): string {
  const idx = path.lastIndexOf('/');
  if (idx <= 0) return '/';
  return path.substring(0, idx);
}

function joinPath(parent: string, name: string): string {
  if (parent.endsWith('/') || parent.endsWith(':')) return `${parent}${name}`;
  return `${parent}/${name}`;
}

// --- Component ---

const SftpPanel: React.FC<SftpPanelProps> = ({ onOpenFile }) => {
  const connections = useSftpStore((s) => s.connections);
  const activeConnectionId = useSftpStore((s) => s.activeConnectionId);
  const setActiveConnection = useSftpStore((s) => s.setActiveConnection);
  const closeConnection = useSftpStore((s) => s.closeConnection);
  const getStartPath = useSftpStore((s) => s.getStartPath);

  // Root path and tree state
  const [rootPath, setRootPath] = useState('/');
  const [pathInputValue, setPathInputValue] = useState('/');
  const [rootEntries, setRootEntries] = useState<FileEntry[]>([]);
  const [expandedDirs, setExpandedDirs] = useState<Record<string, FileEntry[]>>({});
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(new Set());
  const [rootLoading, setRootLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Selection and interaction
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const { ref: contextMenuRef, style: contextMenuStyle } = useClampedMenuPosition(contextMenu);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const renameInputRef = useRef<HTMLInputElement>(null);

  // New folder dialog
  const [showNewFolderDialog, setShowNewFolderDialog] = useState(false);
  const [newFolderParent, setNewFolderParent] = useState('/');
  const [newFolderName, setNewFolderName] = useState('');

  // Delete confirmation
  const [deleteTarget, setDeleteTarget] = useState<FileEntry | null>(null);

  // Drag and drop
  const [isDragging, setIsDragging] = useState(false);

  // Transfers
  const [transfers, setTransfers] = useState<TransferItem[]>([]);
  const [isTransferMinimized, setIsTransferMinimized] = useState(false);
  const transferIdRef = useRef(0);
  // Tracks IDs cancelled mid-flight. Reads are synchronous, unlike `transfers`
  // state which is stale inside async closures captured before the cancel.
  const cancelledTransferIdsRef = useRef<Set<string>>(new Set());

  // File input for upload
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadTargetPath = useRef('/');

  const activeConnection = connections.find((c) => c.id === activeConnectionId);
  const sftpId = activeConnectionId;

  // --- Load root directory ---

  const loadRoot = useCallback(
    async (path: string) => {
      if (!sftpId) return;
      try {
        setRootLoading(true);
        setError(null);
        const result = await sftpLs(sftpId, path);
        setRootEntries(sortEntries(result.entries));
        setRootPath(result.path || path);
        setPathInputValue(result.path || path);
        // Clear expanded state on root change
        setExpandedDirs({});
        setSelectedPath(null);
      } catch (err) {
        setError(getErrorMessage(err, 'Failed to load directory'));
      } finally {
        setRootLoading(false);
      }
    },
    [sftpId]
  );

  // Reload when active connection changes
  useEffect(() => {
    if (!activeConnectionId) {
      setRootEntries([]);
      setExpandedDirs({});
      setError(null);
      return;
    }
    const startPath = getStartPath(activeConnectionId);
    loadRoot(startPath);
  }, [activeConnectionId, getStartPath, loadRoot]);

  // --- Directory expansion ---

  const toggleDir = useCallback(
    async (dirPath: string) => {
      if (!sftpId) return;

      // If already expanded, collapse
      if (expandedDirs[dirPath] !== undefined) {
        setExpandedDirs((prev) => {
          const next = { ...prev };
          delete next[dirPath];
          // Also collapse all children
          for (const key of Object.keys(next)) {
            if (key.startsWith(dirPath + '/') || key.startsWith(dirPath + ':')) {
              delete next[key];
            }
          }
          return next;
        });
        return;
      }

      // Load children
      setLoadingDirs((prev) => new Set(prev).add(dirPath));
      try {
        const result = await sftpLs(sftpId, dirPath);
        setExpandedDirs((prev) => ({
          ...prev,
          [dirPath]: sortEntries(result.entries),
        }));
      } catch (err) {
        setError(getErrorMessage(err, 'Failed to load directory'));
      } finally {
        setLoadingDirs((prev) => {
          const next = new Set(prev);
          next.delete(dirPath);
          return next;
        });
      }
    },
    [sftpId, expandedDirs]
  );

  // --- Refresh a specific directory (or root) ---

  const refreshDir = useCallback(
    async (dirPath: string) => {
      if (!sftpId) return;
      try {
        const result = await sftpLs(sftpId, dirPath);
        const sorted = sortEntries(result.entries);
        if (dirPath === rootPath) {
          setRootEntries(sorted);
        } else if (expandedDirs[dirPath] !== undefined) {
          setExpandedDirs((prev) => ({ ...prev, [dirPath]: sorted }));
        }
      } catch {
        // Silently fail refreshes
      }
    },
    [sftpId, rootPath, expandedDirs]
  );

  const refreshRoot = useCallback(() => {
    loadRoot(rootPath);
  }, [loadRoot, rootPath]);

  // --- Navigate path bar ---

  const handlePathSubmit = () => {
    const trimmed = pathInputValue.trim();
    if (trimmed) {
      loadRoot(trimmed);
    }
  };

  // --- Download ---

  const handleDownload = useCallback(async (entry: FileEntry) => {
    if (!sftpId) return;
    const transferId = `download-${++transferIdRef.current}`;
    const newTransfer: TransferItem = {
      id: transferId,
      filename: entry.name,
      path: entry.path,
      size: entry.size,
      type: 'download',
      status: 'active',
      progress: 0,
      bytesTransferred: 0,
      startTime: Date.now(),
    };

    setTransfers((prev) => [...prev, newTransfer]);
    setIsTransferMinimized(false);

    // Real bytes-on-the-wire progress from axios's onDownloadProgress.
    // The bar advances monotonically as bytes arrive — no fake animation.
    const handleProgress = (loaded: number, total: number | undefined) => {
      const knownTotal = total ?? entry.size;
      setTransfers((prev) =>
        prev.map((t) => {
          if (t.id !== transferId || t.status !== 'active') return t;
          const progress = knownTotal > 0
            ? Math.min((loaded / knownTotal) * 100, 100)
            : 0;
          return { ...t, progress, bytesTransferred: loaded };
        })
      );
    };

    try {
      const blob = await sftpDownload(sftpId, entry.path, undefined, handleProgress);

      if (cancelledTransferIdsRef.current.has(transferId)) {
        return;
      }

      setTransfers((prev) =>
        prev.map((t) =>
          t.id === transferId
            ? { ...t, status: 'completed' as const, progress: 100, bytesTransferred: entry.size }
            : t
        )
      );

      downloadFile(blob, entry.name);
    } catch (err) {
      setTransfers((prev) =>
        prev.map((t) =>
          t.id === transferId
            ? {
                ...t,
                status: 'error' as const,
                error: getErrorMessage(err, 'Download failed'),
              }
            : t
        )
      );
    }
  }, [sftpId]);

  // --- Double-click actions ---

  const handleDoubleClick = useCallback(
    (entry: FileEntry) => {
      if (entry.is_dir) {
        toggleDir(entry.path);
      } else if (sftpId && activeConnection && isTextFile(entry.name, entry.size)) {
        onOpenFile(sftpId, entry.path, entry.name, activeConnection.deviceName);
      } else if (sftpId) {
        handleDownload(entry);
      }
    },
    [sftpId, activeConnection, toggleDir, onOpenFile, handleDownload]
  );

  // --- Upload ---

  const handleUpload = async (files: FileList | null, targetPath: string) => {
    if (!files || files.length === 0 || !sftpId) return;

    setIsTransferMinimized(false);

    const newTransfers: TransferItem[] = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const transferId = `upload-${++transferIdRef.current}`;
      const path = joinPath(targetPath, file.name);
      newTransfers.push({
        id: transferId,
        filename: file.name,
        path,
        size: file.size,
        type: 'upload',
        status: i === 0 ? 'active' : 'pending',
        progress: 0,
        bytesTransferred: 0,
        startTime: i === 0 ? Date.now() : undefined,
      });
    }

    setTransfers((prev) => [...prev, ...newTransfers]);

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const transfer = newTransfers[i];

      if (i > 0) {
        setTransfers((prev) =>
          prev.map((t) =>
            t.id === transfer.id
              ? { ...t, status: 'active' as const, startTime: Date.now() }
              : t
          )
        );
      }

      if (cancelledTransferIdsRef.current.has(transfer.id)) {
        continue;
      }

      // Real bytes-on-the-wire progress from axios's onUploadProgress.
      // `loaded` is bytes actually sent by the browser to the agent.
      const handleProgress = (loaded: number, total: number | undefined) => {
        const knownTotal = total ?? file.size;
        setTransfers((prev) =>
          prev.map((t) => {
            if (t.id !== transfer.id || t.status !== 'active') return t;
            const progress = knownTotal > 0
              ? Math.min((loaded / knownTotal) * 100, 100)
              : 0;
            return { ...t, progress, bytesTransferred: loaded };
          })
        );
      };

      try {
        const buffer = await file.arrayBuffer();
        await sftpUpload(sftpId, transfer.path, buffer, undefined, handleProgress);

        if (cancelledTransferIdsRef.current.has(transfer.id)) {
          continue;
        }

        setTransfers((prev) =>
          prev.map((t) =>
            t.id === transfer.id
              ? { ...t, status: 'completed' as const, progress: 100, bytesTransferred: file.size }
              : t
          )
        );
      } catch (err) {
        setTransfers((prev) =>
          prev.map((t) =>
            t.id === transfer.id
              ? {
                  ...t,
                  status: 'error' as const,
                  error: getErrorMessage(err, 'Upload failed'),
                }
              : t
          )
        );
      }
    }

    // Refresh the target dir
    refreshDir(targetPath);
  };

  // --- New folder ---

  const handleNewFolder = async () => {
    if (!newFolderName.trim() || !sftpId) return;
    try {
      const path = joinPath(newFolderParent, newFolderName.trim());
      await sftpMkdir(sftpId, path);
      setShowNewFolderDialog(false);
      setNewFolderName('');
      refreshDir(newFolderParent);
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to create folder'));
    }
  };

  // --- Rename ---

  const startRename = (entry: FileEntry) => {
    setRenamingPath(entry.path);
    setRenameValue(entry.name);
    setContextMenu(null);
    setTimeout(() => renameInputRef.current?.select(), 0);
  };

  const finishRename = async () => {
    if (!sftpId || !renamingPath || !renameValue.trim()) {
      setRenamingPath(null);
      return;
    }

    const parentPath = getParentPath(renamingPath);
    const originalName = renamingPath.split('/').pop() || '';
    if (renameValue.trim() === originalName) {
      setRenamingPath(null);
      return;
    }

    try {
      const newPath = joinPath(parentPath, renameValue.trim());
      await sftpRename(sftpId, renamingPath, newPath);
      setRenamingPath(null);
      refreshDir(parentPath);
    } catch (err) {
      setError(getErrorMessage(err, 'Rename failed'));
      setRenamingPath(null);
    }
  };

  // --- Delete ---

  const handleDelete = async () => {
    if (!deleteTarget || !sftpId) return;
    try {
      await sftpRm(sftpId, deleteTarget.path, deleteTarget.is_dir);
      const parentPath = getParentPath(deleteTarget.path);
      setDeleteTarget(null);
      // Clean up expanded state if deleting a dir
      if (deleteTarget.is_dir) {
        setExpandedDirs((prev) => {
          const next = { ...prev };
          delete next[deleteTarget.path];
          for (const key of Object.keys(next)) {
            if (key.startsWith(deleteTarget.path + '/')) {
              delete next[key];
            }
          }
          return next;
        });
      }
      refreshDir(parentPath);
    } catch (err) {
      setError(getErrorMessage(err, 'Delete failed'));
      setDeleteTarget(null);
    }
  };

  // --- Copy path ---

  const handleCopyPath = (path: string) => {
    navigator.clipboard.writeText(path).catch(() => {});
    setContextMenu(null);
  };

  // --- Context menu ---

  const handleContextMenu = (
    e: React.MouseEvent,
    entry: FileEntry | null,
    parentPath: string
  ) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, entry, parentPath });
  };

  // Close context menu on any click
  useEffect(() => {
    const handleClick = () => setContextMenu(null);
    document.addEventListener('click', handleClick);
    return () => document.removeEventListener('click', handleClick);
  }, []);

  // --- Drag & Drop ---

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    // Only hide when actually leaving the panel
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    handleUpload(e.dataTransfer.files, rootPath);
  };

  // Upload by absolute filesystem path — used by the Tauri webview
  // drag-drop bridge (see useTauriDragDrop below). Reads each file
  // via the Tauri fs plugin (faster + more reliable than the FileList
  // round-trip) and synthesizes pseudo-File objects so the existing
  // handleUpload path can stay the single source of truth for progress
  // tracking + cancellation.
  const handleUploadFromPaths = useCallback(async (paths: string[], targetPath: string) => {
    if (!sftpId || paths.length === 0) return;
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const fileList: File[] = [];
      for (const absPath of paths) {
        try {
          const bytes = await invoke<number[] | Uint8Array>('read_dropped_file', { path: absPath });
          // Always copy into a fresh Uint8Array so the buffer is a
          // concrete ArrayBuffer (BlobPart rejects ArrayBufferLike
          // under strict TS).
          const u8 = new Uint8Array(bytes);
          // Basename only — sftpUpload doesn't recurse directories,
          // and read_dropped_file already rejects non-regular files.
          const name = absPath.split(/[\\/]/).pop() || 'file';
          fileList.push(new File([u8], name));
        } catch (err) {
          console.warn('[SftpPanel] Skipping non-file drop entry:', absPath, err);
        }
      }
      if (fileList.length === 0) return;
      // Synthesize a FileList-like object so handleUpload's signature
      // matches without changes. The cast is safe — handleUpload only
      // uses length + index access + .arrayBuffer().
      const synthetic = {
        length: fileList.length,
        item: (i: number) => fileList[i],
        [Symbol.iterator]: function* () { yield* fileList; },
      };
      for (let i = 0; i < fileList.length; i++) {
        (synthetic as unknown as { [k: number]: File })[i] = fileList[i];
      }
      await handleUpload(synthetic as unknown as FileList, targetPath);
    } catch (err) {
      console.error('[SftpPanel] Tauri drop upload failed:', err);
    }
  }, [sftpId]);

  // Tauri v2 captures native OS file drops at the WebView layer before
  // they reach the DOM, so the React onDrop above only fires for
  // intra-app drags. Bridge real OS drops onto the same handler via
  // the global drag-drop coordinator — see lib/tauriDragDrop.ts.
  useTauriDragDrop({
    selector: '.sftp-panel',
    onDrop: (paths) => { void handleUploadFromPaths(paths, rootPath); },
  });

  // --- Transfer handlers ---

  const handleCancelTransfer = useCallback((id: string) => {
    cancelledTransferIdsRef.current.add(id);
    setTransfers((prev) =>
      prev.map((t) =>
        t.id === id && (t.status === 'active' || t.status === 'pending')
          ? { ...t, status: 'cancelled' as const }
          : t
      )
    );
  }, []);

  const handleClearTransfer = useCallback((id: string) => {
    setTransfers((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const handleClearAllTransfers = useCallback(() => {
    setTransfers((prev) => prev.filter((t) => t.status === 'active' || t.status === 'pending'));
  }, []);

  const activeTransferCount = transfers.filter(
    (t) => t.status === 'active' || t.status === 'pending'
  ).length;

  // --- Render tree item ---

  const renderTreeItem = (entry: FileEntry, depth: number, parentPath: string) => {
    const isExpanded = expandedDirs[entry.path] !== undefined;
    const isLoading = loadingDirs.has(entry.path);
    const isSelected = selectedPath === entry.path;
    const isRenaming = renamingPath === entry.path;
    const indentPx = depth * 16;

    return (
      <React.Fragment key={entry.path}>
        <div
          className={`sftp-tree-item${isSelected ? ' selected' : ''}`}
          style={{ paddingLeft: `${8 + indentPx}px` }}
          onClick={() => setSelectedPath(entry.path)}
          onDoubleClick={() => handleDoubleClick(entry)}
          onContextMenu={(e) => handleContextMenu(e, entry, parentPath)}
        >
          {/* Arrow / spacer */}
          {entry.is_dir ? (
            <div
              className={`sftp-tree-arrow${isExpanded ? ' expanded' : ''}`}
              onClick={(e) => {
                e.stopPropagation();
                toggleDir(entry.path);
              }}
            >
              <ChevronIcon />
            </div>
          ) : (
            <div className="sftp-tree-arrow placeholder" />
          )}

          {/* Icon */}
          <div className={`sftp-tree-icon ${entry.is_dir ? 'folder' : 'file'}`}>
            {entry.is_dir ? <FolderIcon /> : <FileIcon />}
          </div>

          {/* Name or rename input */}
          {isRenaming ? (
            <input
              ref={renameInputRef}
              className="sftp-tree-rename-input"
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onBlur={finishRename}
              onKeyDown={(e) => {
                if (e.key === 'Enter') finishRename();
                if (e.key === 'Escape') setRenamingPath(null);
              }}
              onClick={(e) => e.stopPropagation()}
              autoFocus
            />
          ) : (
            <span className="sftp-tree-name" title={entry.path}>
              {entry.name}
            </span>
          )}

          {/* Size (files only) */}
          {!entry.is_dir && !isRenaming && (
            <span className="sftp-tree-size">{formatFileSize(entry.size)}</span>
          )}
        </div>

        {/* Loading indicator for expanding dir */}
        {entry.is_dir && isLoading && (
          <div className="sftp-tree-loading" style={{ paddingLeft: `${8 + (depth + 1) * 16}px` }}>
            <div className="sftp-tree-spinner" />
            Loading...
          </div>
        )}

        {/* Children */}
        {entry.is_dir && isExpanded && expandedDirs[entry.path] && (
          <>
            {expandedDirs[entry.path].length === 0 ? (
              <div
                className="sftp-tree-loading"
                style={{ paddingLeft: `${8 + (depth + 1) * 16}px` }}
              >
                Empty directory
              </div>
            ) : (
              expandedDirs[entry.path].map((child) =>
                renderTreeItem(child, depth + 1, entry.path)
              )
            )}
          </>
        )}
      </React.Fragment>
    );
  };

  // --- Render ---

  // No connections at all
  if (connections.length === 0) {
    return (
      <div className="sftp-panel">
        <div className="sftp-panel-header">
          <span className="sftp-panel-title">SFTP</span>
        </div>
        <div className="sftp-panel-no-connections">
          No SFTP connections open. Right-click a session tab and select "Open SFTP" to connect.
        </div>
      </div>
    );
  }

  return (
    <div
      className="sftp-panel"
      data-testid="sftp-panel" onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      style={{ position: 'relative' }}
    >
      {/* Header: connection selector + close */}
      <div className="sftp-panel-header">
        <span className="sftp-panel-title">SFTP</span>
        <select
          className="sftp-panel-connection-select"
          value={activeConnectionId || ''}
          onChange={(e) => setActiveConnection(e.target.value)}
        >
          {connections.map((c) => (
            <option key={c.id} value={c.id}>
              {c.deviceName}
            </option>
          ))}
        </select>
        {activeConnectionId && (
          <button
            className="sftp-panel-close-btn"
            onClick={() => closeConnection(activeConnectionId)}
            title="Disconnect SFTP"
          >
            <CloseIcon />
          </button>
        )}
      </div>

      {/* Path bar */}
      {activeConnectionId && (
        <div className="sftp-panel-pathbar">
          <input
            className="sftp-panel-path-input"
            value={pathInputValue}
            onChange={(e) => setPathInputValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handlePathSubmit();
            }}
          />
          <button
            className="sftp-panel-refresh-btn"
            onClick={refreshRoot}
            disabled={rootLoading}
            title="Refresh"
          >
            <RefreshIcon />
          </button>
        </div>
      )}

      {/* Error display */}
      {error && (
        <div className="sftp-panel-error">
          <span>{error}</span>
          <button onClick={() => setError(null)}>Dismiss</button>
        </div>
      )}

      {/* Connection error */}
      {activeConnection && !activeConnection.connected && activeConnection.error && (
        <div className="sftp-panel-error">
          <span>{activeConnection.error}</span>
        </div>
      )}

      {/* File tree */}
      <div
        className={`sftp-panel-tree${isDragging ? ' dragging-over' : ''}`}
        onContextMenu={(e) => handleContextMenu(e, null, rootPath)}
      >
        {rootLoading ? (
          <div className="sftp-panel-status">
            <div className="sftp-tree-spinner" style={{ margin: '0 auto 8px' }} />
            Loading...
          </div>
        ) : rootEntries.length === 0 && activeConnectionId ? (
          <div className="sftp-panel-empty">
            <FolderIcon />
            <span>Empty directory</span>
          </div>
        ) : (
          rootEntries.map((entry) => renderTreeItem(entry, 0, rootPath))
        )}
      </div>

      {/* Action bar */}
      {activeConnectionId && (
        <div className="sftp-panel-actions">
          <button
            className="sftp-panel-action-btn"
            onClick={() => {
              uploadTargetPath.current = rootPath;
              fileInputRef.current?.click();
            }}
            title="Upload files"
          >
            <UploadIcon />
            Upload
          </button>
          <button
            className="sftp-panel-action-btn"
            onClick={() => {
              setNewFolderParent(rootPath);
              setNewFolderName('');
              setShowNewFolderDialog(true);
            }}
            title="New folder"
          >
            <NewFolderIcon />
            New Folder
          </button>
          {activeTransferCount > 0 && (
            <div
              className="sftp-panel-transfer-status"
              onClick={() => setIsTransferMinimized(false)}
            >
              <span className="sftp-panel-transfer-dot" />
              {activeTransferCount} transfer{activeTransferCount > 1 ? 's' : ''}
            </div>
          )}
        </div>
      )}

      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        style={{ display: 'none' }}
        onChange={(e) => {
          handleUpload(e.target.files, uploadTargetPath.current);
          // Reset so same file can be selected again
          if (fileInputRef.current) fileInputRef.current.value = '';
        }}
      />

      {/* Transfer progress */}
      {transfers.length > 0 && (
        <div className="sftp-panel-transfers">
          <TransferProgress
            transfers={transfers}
            onCancel={handleCancelTransfer}
            onClear={handleClearTransfer}
            onClearAll={handleClearAllTransfers}
            onMinimize={() => setIsTransferMinimized(!isTransferMinimized)}
            isMinimized={isTransferMinimized}
          />
        </div>
      )}

      {/* Drop zone overlay */}
      {isDragging && (
        <div className="sftp-panel-drop-overlay">
          <div className="sftp-panel-drop-text">Drop files to upload</div>
        </div>
      )}

      {/* Context menu */}
      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="sftp-panel-context-menu"
          style={contextMenuStyle}
          onClick={(e) => e.stopPropagation()}
        >
          {contextMenu.entry ? (
            <>
              {/* File-specific actions */}
              {!contextMenu.entry.is_dir && (
                <>
                  <button
                    className="sftp-panel-context-item"
                    onClick={() => {
                      handleDownload(contextMenu.entry!);
                      setContextMenu(null);
                    }}
                  >
                    <DownloadIcon /> Download
                  </button>
                  {isTextFile(contextMenu.entry.name, contextMenu.entry.size) &&
                    sftpId &&
                    activeConnection && (
                      <button
                        className="sftp-panel-context-item"
                        onClick={() => {
                          onOpenFile(
                            sftpId!,
                            contextMenu.entry!.path,
                            contextMenu.entry!.name,
                            activeConnection!.deviceName
                          );
                          setContextMenu(null);
                        }}
                      >
                        <OpenFileIcon /> Open in Editor
                      </button>
                    )}
                </>
              )}
              {/* Directory-specific actions */}
              {contextMenu.entry.is_dir && (
                <>
                  <button
                    className="sftp-panel-context-item"
                    onClick={() => {
                      setNewFolderParent(contextMenu.entry!.path);
                      setNewFolderName('');
                      setShowNewFolderDialog(true);
                      setContextMenu(null);
                    }}
                  >
                    <NewFolderIcon /> New Folder
                  </button>
                  <button
                    className="sftp-panel-context-item"
                    onClick={() => {
                      uploadTargetPath.current = contextMenu.entry!.path;
                      fileInputRef.current?.click();
                      setContextMenu(null);
                    }}
                  >
                    <UploadIcon /> Upload Here
                  </button>
                </>
              )}
              <div className="sftp-panel-context-divider" />
              <button
                className="sftp-panel-context-item"
                onClick={() => startRename(contextMenu.entry!)}
              >
                <EditIcon /> Rename
              </button>
              <button
                className="sftp-panel-context-item"
                onClick={() => handleCopyPath(contextMenu.entry!.path)}
              >
                <CopyIcon /> Copy Path
              </button>
              <div className="sftp-panel-context-divider" />
              <button
                className="sftp-panel-context-item danger"
                onClick={() => {
                  setDeleteTarget(contextMenu.entry!);
                  setContextMenu(null);
                }}
              >
                <TrashIcon /> Delete
              </button>
            </>
          ) : (
            <>
              {/* Empty space context menu */}
              <button
                className="sftp-panel-context-item"
                onClick={() => {
                  uploadTargetPath.current = contextMenu.parentPath;
                  fileInputRef.current?.click();
                  setContextMenu(null);
                }}
              >
                <UploadIcon /> Upload Files
              </button>
              <button
                className="sftp-panel-context-item"
                onClick={() => {
                  setNewFolderParent(contextMenu.parentPath);
                  setNewFolderName('');
                  setShowNewFolderDialog(true);
                  setContextMenu(null);
                }}
              >
                <NewFolderIcon /> New Folder
              </button>
              <div className="sftp-panel-context-divider" />
              <button
                className="sftp-panel-context-item"
                onClick={() => {
                  refreshRoot();
                  setContextMenu(null);
                }}
              >
                <RefreshIcon /> Refresh
              </button>
            </>
          )}
        </div>
      )}

      {/* New folder dialog */}
      {showNewFolderDialog && (
        <div className="sftp-panel-dialog-overlay" onClick={() => setShowNewFolderDialog(false)}>
          <div className="sftp-panel-dialog" onClick={(e) => e.stopPropagation()}>
            <h3>New Folder</h3>
            <input
              type="text"
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              placeholder="Folder name"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleNewFolder();
                if (e.key === 'Escape') setShowNewFolderDialog(false);
              }}
            />
            <div className="sftp-panel-dialog-buttons">
              <button className="secondary" onClick={() => setShowNewFolderDialog(false)}>
                Cancel
              </button>
              <button className="primary" onClick={handleNewFolder}>
                Create
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete confirmation dialog */}
      {deleteTarget && (
        <div className="sftp-panel-dialog-overlay" onClick={() => setDeleteTarget(null)}>
          <div className="sftp-panel-dialog" onClick={(e) => e.stopPropagation()}>
            <h3>Delete {deleteTarget.is_dir ? 'Folder' : 'File'}</h3>
            <p>
              Are you sure you want to delete <strong>{deleteTarget.name}</strong>?
              {deleteTarget.is_dir && ' This will delete all contents inside it.'}
            </p>
            <div className="sftp-panel-dialog-buttons">
              <button className="secondary" onClick={() => setDeleteTarget(null)}>
                Cancel
              </button>
              <button className="danger" onClick={handleDelete}>
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default SftpPanel;
