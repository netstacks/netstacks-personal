import { useState, useCallback, useRef, useEffect } from 'react';
import './SecureCRTImportDialog.css';
import {
  parseSecureCRTXml,
  countSelectedSessions,
  getAllFolderIds,
  type SecureCRTFolder,
  type SecureCRTParseResult,
} from '../lib/securecrt';
import { listProfiles, type CredentialProfile } from '../api/profiles';
import { createFolder, createSession, listFolders } from '../api/sessions';

// --- Inline SVG Icons ---

import { getErrorMessage } from '../api/errors'
const CloseIcon = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <line x1="3" y1="3" x2="11" y2="11" />
    <line x1="11" y1="3" x2="3" y2="11" />
  </svg>
);

const FolderIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
    <path d="M1 3.5A1.5 1.5 0 0 1 2.5 2h3.879a1.5 1.5 0 0 1 1.06.44l1.122 1.12A1.5 1.5 0 0 0 9.62 4H13.5A1.5 1.5 0 0 1 15 5.5v7a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 1 12.5v-9z" />
  </svg>
);

const FolderOpenIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
    <path d="M1 3.5A1.5 1.5 0 0 1 2.5 2h3.879a1.5 1.5 0 0 1 1.06.44l1.122 1.12A1.5 1.5 0 0 0 9.62 4H13.5A1.5 1.5 0 0 1 15 5.5v1H2.5A1.5 1.5 0 0 0 1 8v-4.5zM2.5 8a.5.5 0 0 0-.484.372l-1.5 5.5A.5.5 0 0 0 1 14.5h11.5a.5.5 0 0 0 .484-.372l1.5-5.5A.5.5 0 0 0 14 8H2.5z" />
  </svg>
);

const ChevronIcon = () => (
  <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
    <path d="M3.5 1.5L7.5 5L3.5 8.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
  </svg>
);

// --- Types ---

type Stage = 'select' | 'importing' | 'done';

interface ImportResults {
  foldersCreated: number;
  sessionsCreated: number;
  warnings: string[];
}

interface SecureCRTImportDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onImportComplete: () => void;
}

// --- FolderTreeNode sub-component ---

interface FolderTreeNodeProps {
  folder: SecureCRTFolder;
  depth: number;
  selectedIds: Set<string>;
  expandedIds: Set<string>;
  onToggleSelect: (folder: SecureCRTFolder) => void;
  onToggleExpand: (folderId: string) => void;
}

function FolderTreeNode({
  folder,
  depth,
  selectedIds,
  expandedIds,
  onToggleSelect,
  onToggleExpand,
}: FolderTreeNodeProps) {
  const isSelected = selectedIds.has(folder.id);
  const isExpanded = expandedIds.has(folder.id);
  const hasChildren = folder.children.length > 0;

  // Count total sessions in this folder and all descendants
  const totalSessions = countFolderSessions(folder);

  return (
    <>
      <div
        className="scrt-tree-folder-row"
        style={{ paddingLeft: `${8 + depth * 20}px` }}
        onClick={() => onToggleSelect(folder)}
      >
        <input
          type="checkbox"
          checked={isSelected}
          onChange={() => onToggleSelect(folder)}
          onClick={(e) => e.stopPropagation()}
        />
        <span
          className={`scrt-tree-toggle ${hasChildren ? (isExpanded ? 'expanded' : '') : 'hidden'}`}
          onClick={(e) => {
            e.stopPropagation();
            if (hasChildren) onToggleExpand(folder.id);
          }}
        >
          <ChevronIcon />
        </span>
        <span className="scrt-tree-folder-icon">
          {isExpanded && hasChildren ? <FolderOpenIcon /> : <FolderIcon />}
        </span>
        <span className="scrt-tree-folder-name">{folder.name}</span>
        <span className="scrt-tree-folder-count">
          {totalSessions} {totalSessions === 1 ? 'session' : 'sessions'}
        </span>
      </div>
      {isExpanded &&
        folder.children.map((child) => (
          <FolderTreeNode
            key={child.id}
            folder={child}
            depth={depth + 1}
            selectedIds={selectedIds}
            expandedIds={expandedIds}
            onToggleSelect={onToggleSelect}
            onToggleExpand={onToggleExpand}
          />
        ))}
    </>
  );
}

/** Count all sessions in a folder and its descendants */
function countFolderSessions(folder: SecureCRTFolder): number {
  let count = folder.sessions.length;
  for (const child of folder.children) {
    count += countFolderSessions(child);
  }
  return count;
}

/** Collect all descendant folder IDs (not including the folder itself) */
function getDescendantIds(folder: SecureCRTFolder): string[] {
  const ids: string[] = [];
  for (const child of folder.children) {
    ids.push(child.id);
    ids.push(...getDescendantIds(child));
  }
  return ids;
}

// --- Main Dialog Component ---

export default function SecureCRTImportDialog({
  isOpen,
  onClose,
  onImportComplete,
}: SecureCRTImportDialogProps) {
  // Stage
  const [stage, setStage] = useState<Stage>('select');

  // File selection
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [parseResult, setParseResult] = useState<SecureCRTParseResult | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);

  // Profile
  const [profiles, setProfiles] = useState<CredentialProfile[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState<string>('');

  // Tree selection
  const [selectedFolderIds, setSelectedFolderIds] = useState<Set<string>>(new Set());
  const [expandedFolderIds, setExpandedFolderIds] = useState<Set<string>>(new Set());

  // Import progress
  const [progress, setProgress] = useState(0);
  const [progressText, setProgressText] = useState('');

  // Results
  const [results, setResults] = useState<ImportResults | null>(null);

  // Load profiles on first open
  const profilesLoadedRef = useRef(false);
  useEffect(() => {
    if (isOpen && !profilesLoadedRef.current) {
      profilesLoadedRef.current = true;
      listProfiles()
        .then((p) => {
          setProfiles(p);
          if (p.length > 0 && !selectedProfileId) {
            setSelectedProfileId(p[0].id);
          }
        })
        .catch(() => {
          // Profiles will remain empty; user sees empty dropdown
        });
    }
  }, [isOpen, selectedProfileId]);

  // Reset state on close
  const resetState = useCallback(() => {
    setStage('select');
    setFileName(null);
    setParseResult(null);
    setParseError(null);
    setSelectedFolderIds(new Set());
    setExpandedFolderIds(new Set());
    setProgress(0);
    setProgressText('');
    setResults(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  }, []);

  // When set true, the import loop stops scheduling new createFolder/
  // createSession calls. In-flight calls still complete (the underlying
  // APIs don't accept AbortSignal yet) but the per-row 60s timeout caps
  // how long the user has to wait after they hit Cancel.
  const cancelRequestedRef = useRef(false);

  const handleClose = useCallback(() => {
    cancelRequestedRef.current = true;
    resetState();
    onClose();
  }, [resetState, onClose]);

  const handleOverlayClick = useCallback(
    (e: React.MouseEvent) => {
      // Suppress backdrop click during import to avoid losing a long
      // import to a stray click. The X button still works.
      if (stage === 'importing') return;
      if (e.target === e.currentTarget) {
        handleClose();
      }
    },
    [handleClose, stage],
  );

  // Wrap a per-row API call in a timeout so a single hung create won't
  // pin the import indefinitely. 60s is generous for SSH-backed creates;
  // anything slower is a real backend problem worth surfacing.
  const withRowTimeout = useCallback(
    <T,>(label: string, p: Promise<T>): Promise<T> =>
      new Promise<T>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`${label} timed out after 60s`)),
          60_000,
        );
        p.then(
          (v) => { clearTimeout(timer); resolve(v); },
          (e) => { clearTimeout(timer); reject(e); },
        );
      }),
    [],
  );

  // File handling
  const handleFileSelect = useCallback(
    (file: File) => {
      setParseError(null);
      setFileName(file.name);

      const reader = new FileReader();
      reader.onload = (e) => {
        const text = e.target?.result as string;
        try {
          const result = parseSecureCRTXml(text);
          if (result.allSessions.length === 0) {
            setParseError(
              result.warnings.length > 0
                ? result.warnings[0]
                : 'No sessions found in the XML file.',
            );
            setParseResult(null);
            return;
          }
          setParseResult(result);

          // Select all folders by default
          const allIds = getAllFolderIds(result.folders);
          setSelectedFolderIds(new Set(allIds));

          // Expand top-level folders
          const topLevelIds = new Set(result.folders.map((f) => f.id));
          setExpandedFolderIds(topLevelIds);
        } catch {
          setParseError('Failed to parse the XML file. Is this a SecureCRT export?');
          setParseResult(null);
        }
      };
      reader.onerror = () => {
        setParseError('Failed to read the file.');
      };
      reader.readAsText(file);
    },
    [],
  );

  const handleFileInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) handleFileSelect(file);
    },
    [handleFileSelect],
  );

  const handleDropZoneClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  // Tree toggle handlers
  const handleToggleSelect = useCallback(
    (folder: SecureCRTFolder) => {
      setSelectedFolderIds((prev) => {
        const next = new Set(prev);
        const descendantIds = getDescendantIds(folder);

        if (next.has(folder.id)) {
          // Deselect this folder and all descendants
          next.delete(folder.id);
          for (const id of descendantIds) {
            next.delete(id);
          }
        } else {
          // Select this folder and all descendants
          next.add(folder.id);
          for (const id of descendantIds) {
            next.add(id);
          }
        }
        return next;
      });
    },
    [],
  );

  const handleToggleExpand = useCallback((folderId: string) => {
    setExpandedFolderIds((prev) => {
      const next = new Set(prev);
      if (next.has(folderId)) {
        next.delete(folderId);
      } else {
        next.add(folderId);
      }
      return next;
    });
  }, []);

  const handleSelectAll = useCallback(() => {
    if (!parseResult) return;
    const allIds = getAllFolderIds(parseResult.folders);
    setSelectedFolderIds(new Set(allIds));
  }, [parseResult]);

  const handleSelectNone = useCallback(() => {
    setSelectedFolderIds(new Set());
  }, []);

  // Selected session count
  const selectedSessionCount = parseResult
    ? countSelectedSessions(parseResult.folders, selectedFolderIds)
    : 0;

  // Import logic
  const handleImport = useCallback(async () => {
    if (!parseResult || !selectedProfileId || selectedFolderIds.size === 0) return;

    cancelRequestedRef.current = false;
    setStage('importing');
    setProgress(0);
    setProgressText('Preparing import...');

    const warnings: string[] = [];
    let foldersCreated = 0;
    let sessionsCreated = 0;

    try {
      // Get existing folders to check for duplicates
      const existingFolders = await listFolders();

      // Build a map of (name, parentId) -> existing folder id
      const existingFolderMap = new Map<string, string>();
      for (const f of existingFolders) {
        const key = `${f.name}::${f.parent_id ?? ''}`;
        existingFolderMap.set(key, f.id);
      }

      // Total items to track progress
      const totalItems = selectedFolderIds.size + selectedSessionCount;
      let processedItems = 0;

      // Map scrt folder id -> netstacks folder id
      const folderIdMap = new Map<string, string>();

      // Recursively create folders and sessions
      async function processFolder(
        folder: SecureCRTFolder,
        parentNetStacksFolderId: string | undefined,
      ) {
        if (cancelRequestedRef.current) return;
        if (!selectedFolderIds.has(folder.id)) {
          // This folder is not selected, but check children individually
          for (const child of folder.children) {
            if (cancelRequestedRef.current) return;
            await processFolder(child, undefined);
          }
          return;
        }

        // Create or find this folder
        const lookupKey = `${folder.name}::${parentNetStacksFolderId ?? ''}`;
        let netStacksFolderId = existingFolderMap.get(lookupKey);

        if (!netStacksFolderId) {
          try {
            const created = await withRowTimeout(
              `Create folder "${folder.name}"`,
              createFolder(folder.name, parentNetStacksFolderId),
            );
            netStacksFolderId = created.id;
            foldersCreated++;
            // Add to map so children and sessions can reference it
            existingFolderMap.set(lookupKey, created.id);
          } catch (err) {
            warnings.push(`Failed to create folder "${folder.name}": ${getErrorMessage(err, String(err))}`);
            processedItems++;
            setProgress(Math.round((processedItems / totalItems) * 100));
            return;
          }
        }

        folderIdMap.set(folder.id, netStacksFolderId);
        processedItems++;
        setProgress(Math.round((processedItems / totalItems) * 100));
        setProgressText(`Creating folders... (${processedItems}/${totalItems})`);

        // Create sessions in this folder
        for (const session of folder.sessions) {
          if (cancelRequestedRef.current) return;
          try {
            await withRowTimeout(
              `Create session "${session.name}"`,
              createSession({
                name: session.name,
                host: session.host,
                port: session.port,
                protocol: session.protocol,
                profile_id: selectedProfileId,
                folder_id: netStacksFolderId,
              }),
            );
            sessionsCreated++;
          } catch (err) {
            warnings.push(`Failed to create session "${session.name}": ${getErrorMessage(err, String(err))}`);
          }
          processedItems++;
          setProgress(Math.round((processedItems / totalItems) * 100));
          setProgressText(`Importing sessions... (${processedItems}/${totalItems})`);
        }

        // Process child folders
        for (const child of folder.children) {
          if (cancelRequestedRef.current) return;
          await processFolder(child, netStacksFolderId);
        }
      }

      // Process all root-level folders
      for (const folder of parseResult.folders) {
        if (cancelRequestedRef.current) break;
        await processFolder(folder, undefined);
      }

      if (cancelRequestedRef.current) {
        warnings.push('Import cancelled by user.');
      }

      // Add any parser warnings
      if (parseResult.warnings.length > 0) {
        warnings.push(...parseResult.warnings);
      }

      setProgress(100);
      setResults({ foldersCreated, sessionsCreated, warnings });
      setStage('done');
    } catch (err) {
      warnings.push(`Import error: ${getErrorMessage(err, String(err))}`);
      setResults({ foldersCreated, sessionsCreated, warnings });
      setStage('done');
    }
  }, [parseResult, selectedProfileId, selectedFolderIds, selectedSessionCount, withRowTimeout]);

  const handleCancelImport = useCallback(() => {
    cancelRequestedRef.current = true;
    setProgressText('Cancelling — finishing the current row…');
  }, []);

  if (!isOpen) return null;

  return (
    <div className="scrt-import-overlay" onClick={handleOverlayClick}>
      <div className="scrt-import-dialog">
        {/* Header */}
        <div className="scrt-import-header">
          <h3>Import SecureCRT Sessions</h3>
          <button
            className="scrt-import-close-btn"
            onClick={handleClose}
            title={stage === 'importing' ? 'Cancel and close — finishes the current row first' : 'Close'}
          >
            <CloseIcon />
          </button>
        </div>

        {/* Body */}
        <div className="scrt-import-body">
          {stage === 'select' && (
            <>
              {/* File picker */}
              <input
                ref={fileInputRef}
                type="file"
                accept=".xml"
                style={{ display: 'none' }}
                onChange={handleFileInputChange}
              />
              <div
                className={`scrt-file-drop ${fileName ? 'has-file' : ''}`}
                onClick={handleDropZoneClick}
              >
                {fileName ? (
                  <>
                    <span className="scrt-file-name">{fileName}</span>
                    <span className="scrt-file-hint">Click to choose a different file</span>
                  </>
                ) : (
                  <>
                    <span className="scrt-file-drop-label">
                      <strong>Choose XML file</strong> to import
                    </span>
                    <span className="scrt-file-hint">SecureCRT session export (.xml)</span>
                  </>
                )}
              </div>

              {/* Error */}
              {parseError && <div className="scrt-error">{parseError}</div>}

              {/* Profile picker */}
              {parseResult && (
                <div className="scrt-profile-picker">
                  <label>Credential Profile</label>
                  <select
                    value={selectedProfileId}
                    onChange={(e) => setSelectedProfileId(e.target.value)}
                  >
                    {profiles.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} ({p.username})
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {/* Tree preview */}
              {parseResult && parseResult.folders.length > 0 && (
                <>
                  <div className="scrt-tree-header">
                    <label>Folders to Import</label>
                    <div className="scrt-tree-actions">
                      <button onClick={handleSelectAll}>Select All</button>
                      <button onClick={handleSelectNone}>Select None</button>
                    </div>
                  </div>
                  <div className="scrt-tree-container">
                    {parseResult.folders.map((folder) => (
                      <FolderTreeNode
                        key={folder.id}
                        folder={folder}
                        depth={0}
                        selectedIds={selectedFolderIds}
                        expandedIds={expandedFolderIds}
                        onToggleSelect={handleToggleSelect}
                        onToggleExpand={handleToggleExpand}
                      />
                    ))}
                  </div>
                  <div className="scrt-summary">
                    <strong>{selectedSessionCount}</strong> session{selectedSessionCount !== 1 ? 's' : ''} selected
                  </div>
                </>
              )}
            </>
          )}

          {stage === 'importing' && (
            <div className="scrt-progress-section">
              <div className="scrt-progress-bar">
                <div className="scrt-progress-fill" style={{ width: `${progress}%` }} />
              </div>
              <div className="scrt-progress-text">{progressText}</div>
            </div>
          )}

          {stage === 'done' && results && (
            <div className="scrt-results">
              <div className="scrt-results-success">Import complete</div>
              <div className="scrt-results-stats">
                <span>{results.foldersCreated} folder{results.foldersCreated !== 1 ? 's' : ''} created</span>
                <span>{results.sessionsCreated} session{results.sessionsCreated !== 1 ? 's' : ''} created</span>
              </div>
              {results.warnings.length > 0 && (
                <div className="scrt-results-warnings">
                  <div className="scrt-results-warnings-label">Warnings</div>
                  <ul>
                    {results.warnings.map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="scrt-import-footer">
          {stage === 'select' && (
            <>
              <button className="scrt-btn-cancel" onClick={handleClose}>
                Cancel
              </button>
              <button
                className="scrt-btn-import"
                disabled={!parseResult || selectedSessionCount === 0 || !selectedProfileId}
                onClick={handleImport}
              >
                Import {selectedSessionCount > 0 ? `(${selectedSessionCount})` : ''}
              </button>
            </>
          )}
          {stage === 'importing' && (
            <button
              className="scrt-btn-cancel"
              onClick={handleCancelImport}
              disabled={cancelRequestedRef.current}
            >
              {cancelRequestedRef.current ? 'Cancelling…' : 'Cancel'}
            </button>
          )}
          {stage === 'done' && (
            <button className="scrt-btn-import" onClick={() => { onImportComplete(); handleClose(); }}>
              Done
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
