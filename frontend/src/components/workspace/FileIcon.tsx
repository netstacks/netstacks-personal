import { Icon } from '@iconify/react'
import { getIconForFile, getIconForFolder, getIconForOpenFolder } from 'vscode-icons-js'

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

export default function FileIcon({ name, isDir, isExpanded }: FileIconProps) {
  const iconName = isDir
    ? toIconifyName(
        isExpanded ? getIconForOpenFolder(name) : getIconForFolder(name),
        'default-folder',
      )
    : toIconifyName(getIconForFile(name), 'default-file')

  return (
    <span className="workspace-file-entry-icon">
      <Icon icon={iconName} width={16} height={16} />
    </span>
  )
}
