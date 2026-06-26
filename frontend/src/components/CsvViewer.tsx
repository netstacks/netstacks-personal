import { useState, useMemo } from 'react';
import './DocumentViewer.css';

interface CsvViewerProps {
  content: string;
  filename?: string; // Reserved for future use (e.g., display in header)
}

interface SortConfig {
  column: number;
  direction: 'asc' | 'desc';
}

// Parse CSV content, handling quoted fields
function parseCSV(content: string): string[][] {
  const rows: string[][] = [];
  if (!content.trim()) return rows;

  const lines = content.split(/\r?\n/);

  for (const line of lines) {
    if (!line.trim()) continue;

    const row: string[] = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      const nextChar = line[i + 1];

      if (inQuotes) {
        if (char === '"' && nextChar === '"') {
          // Escaped quote
          current += '"';
          i++;
        } else if (char === '"') {
          // End of quoted field
          inQuotes = false;
        } else {
          current += char;
        }
      } else {
        if (char === '"') {
          // Start of quoted field
          inQuotes = true;
        } else if (char === ',') {
          // Field separator
          row.push(current.trim());
          current = '';
        } else {
          current += char;
        }
      }
    }

    // Push last field
    row.push(current.trim());
    rows.push(row);
  }

  return rows;
}

// Icons
const Icons = {
  sortAsc: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 5v14M5 12l7-7 7 7" />
    </svg>
  ),
  sortDesc: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 5v14M19 12l-7 7-7-7" />
    </svg>
  ),
  sort: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M7 8l5-5 5 5M7 16l5 5 5-5" />
    </svg>
  ),
};

function CsvViewer({ content }: CsvViewerProps) {
  const [sortConfig, setSortConfig] = useState<SortConfig | null>(null);

  const rows = useMemo(() => parseCSV(content), [content]);

  // Handle empty content
  if (rows.length === 0) {
    return (
      <div className="csv-viewer csv-viewer-empty">
        <p>No data to display</p>
      </div>
    );
  }

  // First row is header
  const headers = rows[0];
  const dataRows = rows.slice(1);

  // Sort data rows
  const sortedRows = useMemo(() => {
    if (!sortConfig) return dataRows;

    const sorted = [...dataRows].sort((a, b) => {
      const aVal = a[sortConfig.column] || '';
      const bVal = b[sortConfig.column] || '';

      // Try numeric comparison first
      const aNum = parseFloat(aVal);
      const bNum = parseFloat(bVal);

      if (!isNaN(aNum) && !isNaN(bNum)) {
        return sortConfig.direction === 'asc' ? aNum - bNum : bNum - aNum;
      }

      // Fall back to string comparison
      const comparison = aVal.localeCompare(bVal, undefined, { numeric: true, sensitivity: 'base' });
      return sortConfig.direction === 'asc' ? comparison : -comparison;
    });

    return sorted;
  }, [dataRows, sortConfig]);

  const handleSort = (columnIndex: number) => {
    setSortConfig((prev) => {
      if (prev?.column === columnIndex) {
        // Toggle direction or clear
        if (prev.direction === 'asc') {
          return { column: columnIndex, direction: 'desc' };
        } else {
          return null; // Clear sort
        }
      }
      return { column: columnIndex, direction: 'asc' };
    });
  };

  const getSortIcon = (columnIndex: number) => {
    if (sortConfig?.column !== columnIndex) {
      return <span className="csv-sort-icon csv-sort-inactive">{Icons.sort}</span>;
    }
    return (
      <span className="csv-sort-icon csv-sort-active">
        {sortConfig.direction === 'asc' ? Icons.sortAsc : Icons.sortDesc}
      </span>
    );
  };

  // Normalize row lengths to match header count
  const maxCols = headers.length;

  return (
    <div className="csv-viewer">
      <div className="csv-table-wrapper">
        <table className="csv-table">
          <thead>
            <tr>
              {headers.map((header, idx) => (
                <th
                  key={idx}
                  onClick={() => handleSort(idx)}
                  className="csv-header-cell"
                  title={`Sort by ${header || `Column ${idx + 1}`}`}
                >
                  <span className="csv-header-text">{header || `Column ${idx + 1}`}</span>
                  {getSortIcon(idx)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sortedRows.length === 0 ? (
              <tr>
                <td colSpan={maxCols} className="csv-empty-row">
                  No data rows
                </td>
              </tr>
            ) : (
              sortedRows.map((row, rowIdx) => (
                <tr key={rowIdx}>
                  {headers.map((_, colIdx) => (
                    <td key={colIdx}>{row[colIdx] || ''}</td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <div className="csv-footer">
        <span className="csv-stats">
          {sortedRows.length} row{sortedRows.length !== 1 ? 's' : ''}, {headers.length} column{headers.length !== 1 ? 's' : ''}
        </span>
      </div>
    </div>
  );
}

export default CsvViewer;
