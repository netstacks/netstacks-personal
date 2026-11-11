// SecureCRT XML session export parser
// Parses VanDyke v3.0 format XML into structured folder/session trees

/**
 * A single SecureCRT session extracted from the XML
 */
export interface SecureCRTSession {
  name: string;
  host: string;
  port: number;
  protocol: 'ssh' | 'telnet';
  folderPath: string[]; // ancestor folder names from root to parent
}

/**
 * A folder node in the SecureCRT session tree
 */
export interface SecureCRTFolder {
  id: string; // unique ID like "scrt-folder-1"
  name: string;
  parentId: string | null;
  children: SecureCRTFolder[];
  sessions: SecureCRTSession[];
}

/**
 * Result of parsing a SecureCRT XML export
 */
export interface SecureCRTParseResult {
  folders: SecureCRTFolder[]; // root-level folders
  allSessions: SecureCRTSession[]; // flat list of every session
  totalFolders: number;
  warnings: string[];
}

/**
 * Get text content of a direct child <string name="X"> element
 */
function getStringValue(parent: Element, name: string): string | null {
  const children = parent.children;
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (
      child.tagName === 'string' &&
      child.getAttribute('name') === name
    ) {
      return child.textContent?.trim() || null;
    }
  }
  return null;
}

/**
 * Get numeric value of a direct child <dword name="X"> element.
 * SecureCRT stores dword values as hexadecimal strings.
 */
function getDwordValue(parent: Element, name: string): number | null {
  const children = parent.children;
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (
      child.tagName === 'dword' &&
      child.getAttribute('name') === name
    ) {
      const text = child.textContent?.trim();
      if (text === null || text === undefined || text === '') return null;
      const val = parseInt(text, 16);
      return isNaN(val) ? null : val;
    }
  }
  return null;
}

/**
 * Check if a <key> element represents a session
 * (has a direct child <dword name="Is Session"> with value 1)
 */
function isSession(element: Element): boolean {
  const val = getDwordValue(element, 'Is Session');
  return val === 1;
}

/**
 * Determine protocol from "Protocol Name" string value.
 * If the value contains "telnet" (case-insensitive), returns "telnet".
 * Otherwise defaults to "ssh".
 */
function resolveProtocol(element: Element): 'ssh' | 'telnet' {
  const proto = getStringValue(element, 'Protocol Name');
  if (proto && proto.toLowerCase().includes('telnet')) {
    return 'telnet';
  }
  return 'ssh';
}

/**
 * Check if an element has any direct child <key> elements
 */
function hasChildKeys(element: Element): boolean {
  const children = element.children;
  for (let i = 0; i < children.length; i++) {
    if (children[i].tagName === 'key') {
      return true;
    }
  }
  return false;
}

/**
 * Result from processing direct children of a <key> element
 */
interface WalkResult {
  folders: SecureCRTFolder[];
  sessions: SecureCRTSession[];
}

/** Mutable context passed through the recursive parse tree walk */
interface ParseContext {
  allSessions: SecureCRTSession[];
  warnings: string[];
  nextFolderId: number;
}

/**
 * Process all direct child <key> elements of a parent, classifying each as
 * either a session or a folder. Returns the folders and sessions found at
 * this level. Recurses into folder children.
 *
 * @param parent - The parent XML element whose direct <key> children to process
 * @param folderPath - Ancestor folder names leading to this level
 * @param parentId - The folder ID of the parent (null for root)
 * @param ctx - Shared parse context (accumulators + ID counter)
 */
function walkChildren(
  parent: Element,
  folderPath: string[],
  parentId: string | null,
  ctx: ParseContext,
): WalkResult {
  const folders: SecureCRTFolder[] = [];
  const sessions: SecureCRTSession[] = [];
  const children = parent.children;

  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (child.tagName !== 'key') continue;

    const name = child.getAttribute('name');
    if (!name) continue;

    if (isSession(child)) {
      // This <key> is a session entry
      const host = getStringValue(child, 'Hostname');
      if (!host) {
        ctx.warnings.push(`Session "${name}" skipped: no Hostname value`);
        continue;
      }

      const port = getDwordValue(child, '[SSH2] Port') ?? 22;
      const protocol = resolveProtocol(child);

      const session: SecureCRTSession = {
        name,
        host,
        port,
        protocol,
        folderPath: [...folderPath],
      };
      sessions.push(session);
      ctx.allSessions.push(session);
    } else if (hasChildKeys(child)) {
      // This <key> has child <key> elements, so treat it as a folder.
      // Note: <key> elements without child keys and without Is Session=1 are
      // skipped — these are SecureCRT internal settings keys (e.g., "Default").
      // Empty folders (no sessions, no sub-folders) are also skipped, which is
      // acceptable since they have no meaningful content to import.
      ctx.nextFolderId++;
      const folderId = `scrt-folder-${ctx.nextFolderId}`;
      const childFolderPath = [...folderPath, name];

      // Recurse into this folder
      const childResult = walkChildren(
        child,
        childFolderPath,
        folderId,
        ctx,
      );

      const folder: SecureCRTFolder = {
        id: folderId,
        name,
        parentId,
        children: childResult.folders,
        sessions: childResult.sessions,
      };

      folders.push(folder);
    }
    // else: <key> with no child keys and not a session — skip (settings key or empty folder)
  }

  return { folders, sessions };
}

/**
 * Parse a SecureCRT XML export string into a structured tree of folders and sessions.
 *
 * Expects VanDyke SecureCRT v3.0 XML format with a root <key name="Sessions">
 * containing nested <key> elements for folders and sessions.
 */
export function parseSecureCRTXml(xmlString: string): SecureCRTParseResult {
  const ctx: ParseContext = {
    allSessions: [],
    warnings: [],
    nextFolderId: 0,
  };

  // Parse the XML
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlString, 'text/xml');

  // Check for XML parse errors
  const parseError = doc.querySelector('parsererror');
  if (parseError) {
    ctx.warnings.push(`XML parse error: ${parseError.textContent?.trim() || 'Unknown error'}`);
    return {
      folders: [],
      allSessions: [],
      totalFolders: 0,
      warnings: ctx.warnings,
    };
  }

  // Find the <key name="Sessions"> root element.
  // It could be the document element itself or nested under another element.
  let sessionsRoot: Element | null = null;

  const docEl = doc.documentElement;
  if (docEl.tagName === 'key' && docEl.getAttribute('name') === 'Sessions') {
    sessionsRoot = docEl;
  } else {
    // Search direct children first
    const children = docEl.children;
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if (child.tagName === 'key' && child.getAttribute('name') === 'Sessions') {
        sessionsRoot = child;
        break;
      }
    }
  }

  if (!sessionsRoot) {
    // Broader fallback search
    const allKeys = doc.getElementsByTagName('key');
    for (let i = 0; i < allKeys.length; i++) {
      if (allKeys[i].getAttribute('name') === 'Sessions') {
        sessionsRoot = allKeys[i];
        break;
      }
    }
  }

  if (!sessionsRoot) {
    ctx.warnings.push('Could not find <key name="Sessions"> in XML. Is this a SecureCRT export?');
    return {
      folders: [],
      allSessions: [],
      totalFolders: 0,
      warnings: ctx.warnings,
    };
  }

  // Walk the tree starting from Sessions root
  const result = walkChildren(sessionsRoot, [], null, ctx);

  // Count total folders recursively
  function countFolders(folderList: SecureCRTFolder[]): number {
    let count = 0;
    for (const f of folderList) {
      count += 1 + countFolders(f.children);
    }
    return count;
  }

  return {
    folders: result.folders,
    allSessions: ctx.allSessions,
    totalFolders: countFolders(result.folders),
    warnings: ctx.warnings,
  };
}

/**
 * Count sessions within folders whose IDs are in the selected set.
 * When a parent folder is selected, all sessions in its descendants are included.
 * When a parent is not selected, its children are still checked individually.
 */
export function countSelectedSessions(
  folders: SecureCRTFolder[],
  selectedFolderIds: Set<string>,
): number {
  let count = 0;

  for (const folder of folders) {
    if (selectedFolderIds.has(folder.id)) {
      // Count this folder's direct sessions plus all descendant sessions
      count += folder.sessions.length;
      count += countAllDescendantSessions(folder.children);
    } else {
      // Not selected, but check children individually
      count += countSelectedSessions(folder.children, selectedFolderIds);
    }
  }

  return count;
}

/**
 * Count all sessions in a list of folders and all their descendants
 */
function countAllDescendantSessions(folders: SecureCRTFolder[]): number {
  let count = 0;
  for (const folder of folders) {
    count += folder.sessions.length;
    count += countAllDescendantSessions(folder.children);
  }
  return count;
}

/**
 * Get all folder IDs in the tree (for "select all" functionality)
 */
export function getAllFolderIds(folders: SecureCRTFolder[]): string[] {
  const ids: string[] = [];

  function collect(folderList: SecureCRTFolder[]) {
    for (const folder of folderList) {
      ids.push(folder.id);
      collect(folder.children);
    }
  }

  collect(folders);
  return ids;
}
