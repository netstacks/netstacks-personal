import { Icon } from '@iconify/react'
import { getIconForFile, getIconForFolder, getIconForOpenFolder } from 'vscode-icons-js'
import {
  DEFAULT_FILE_ICON,
  DEFAULT_FOLDER_ICON,
  DEFAULT_FOLDER_OPENED_ICON,
  useFileIconsReady,
} from '../../lib/iconifyInit'

interface FileIconProps {
  name: string
  isDir: boolean
  isExpanded?: boolean
}

/**
 * Convert vscode-icons-js's `file_type_python.svg` style names into iconify
 * names (`vscode-icons:file-type-python`).
 */
function toIconifyName(svgName: string | undefined, fallback: string): string {
  if (!svgName) return `vscode-icons:${fallback}`
  const base = svgName.replace(/\.svg$/, '').replace(/_/g, '-')
  return `vscode-icons:${base}`
}

function resolveIconName(name: string, isDir: boolean, isExpanded?: boolean): string {
  return isDir
    ? toIconifyName(
        isExpanded ? getIconForOpenFolder(name) : getIconForFolder(name),
        'default-folder',
      )
    : toIconifyName(getIconForFile(name), 'default-file')
}

/**
 * Until the full collection is registered only the default glyphs exist
 * locally; asking for anything else would trigger a (CSP-blocked) CDN fetch.
 */
function defaultIconName(isDir: boolean, isExpanded?: boolean): string {
  if (!isDir) return DEFAULT_FILE_ICON
  return isExpanded ? DEFAULT_FOLDER_OPENED_ICON : DEFAULT_FOLDER_ICON
}

export default function FileIcon({ name, isDir, isExpanded }: FileIconProps) {
  const iconsReady = useFileIconsReady()
  const iconName = iconsReady
    ? resolveIconName(name, isDir, isExpanded)
    : defaultIconName(isDir, isExpanded)

  return (
    <span className="workspace-file-entry-icon">
      <Icon icon={iconName} width={16} height={16} />
    </span>
  )
}
