import { logger } from './logger'
/**
 * Task Export utilities for exporting task results to CSV and Documents
 *
 * Provides:
 * - CSV formatting with proper escaping
 * - Browser download functionality
 * - Auto-save to Documents tab
 */

import type { AgentTask } from '../types/tasks';
import { createDocument } from '../api/docs';
import { escapeCSV, downloadFile } from './formatters';

/**
 * Format a task result as CSV content
 *
 * @param task - The agent task with result
 * @param result - Parsed result object
 * @returns CSV string content
 */
export function formatResultAsCsv(task: AgentTask, result: unknown): string {
  const lines: string[] = [];

  // Add metadata header as comments
  lines.push(`# Task ID: ${task.id}`);
  lines.push(`# Created: ${task.created_at}`);
  lines.push(`# Prompt: ${task.prompt.replace(/\n/g, ' ')}`);
  lines.push('');

  // Handle different result formats
  if (result && typeof result === 'object') {
    // Check for ReAct output format (has 'result' string field from agent)
    if ('result' in result && typeof (result as Record<string, unknown>).result === 'string') {
      lines.push('Result');
      lines.push(escapeCSV((result as Record<string, unknown>).result as string));
      return lines.join('\n');
    }

    // Array of objects - tabular format
    if (Array.isArray(result) && result.length > 0 && typeof result[0] === 'object' && result[0] !== null) {
      const headers = Object.keys(result[0] as Record<string, unknown>);
      lines.push(headers.map(escapeCSV).join(','));

      for (const row of result) {
        const rowObj = row as Record<string, unknown>;
        const values = headers.map((h) => {
          const val = rowObj[h];
          return escapeCSV(val === null || val === undefined ? '' : String(val));
        });
        lines.push(values.join(','));
      }
      return lines.join('\n');
    }

    // Array of primitives
    if (Array.isArray(result)) {
      lines.push('Value');
      for (const item of result) {
        lines.push(escapeCSV(item === null || item === undefined ? '' : String(item)));
      }
      return lines.join('\n');
    }

    // Key-value object
    const obj = result as Record<string, unknown>;
    lines.push('Key,Value');
    for (const [key, value] of Object.entries(obj)) {
      const strValue = value === null || value === undefined ? '' : String(value);
      lines.push(`${escapeCSV(key)},${escapeCSV(strValue)}`);
    }
    return lines.join('\n');
  }

  // Fallback: single value
  lines.push('Result');
  lines.push(escapeCSV(result === null || result === undefined ? '' : String(result)));
  return lines.join('\n');
}

/**
 * Trigger a browser download for CSV content
 *
 * @param content - CSV string content
 * @param filename - Filename without extension
 */
export function downloadCsv(content: string, filename: string): void {
  downloadFile(content, `${filename}.csv`, 'text/csv;charset=utf-8;');
}

/**
 * Export a task result as a CSV download
 *
 * @param task - The agent task to export
 */
export function exportTaskResultAsCsv(task: AgentTask): void {
  logger.log('[taskExport] exportTaskResultAsCsv called with task:', task.id);
  logger.log('[taskExport] result_json:', task.result_json);

  if (!task.result_json) {
    console.warn('[taskExport] No result_json to export for task:', task.id);
    return;
  }

  let result: unknown;
  try {
    result = JSON.parse(task.result_json);
    logger.log('[taskExport] Parsed result:', result);
  } catch (e) {
    console.error('[taskExport] Failed to parse result_json:', e);
    return;
  }

  const csvContent = formatResultAsCsv(task, result);
  logger.log('[taskExport] CSV content length:', csvContent.length);
  logger.log('[taskExport] CSV content preview:', csvContent.slice(0, 200));

  const filename = `task-${task.id.slice(0, 8)}`;
  logger.log('[taskExport] Downloading as:', filename + '.csv');
  downloadCsv(csvContent, filename);
}

/**
 * Save a completed task result to the Documents tab
 *
 * @param task - The completed agent task to save
 * @returns Document ID on success, null on error
 */
export async function saveTaskResultToDoc(task: AgentTask): Promise<string | null> {
  // Only save completed tasks with results
  if (task.status !== 'completed' || !task.result_json) {
    return null;
  }

  let result: unknown;
  try {
    result = JSON.parse(task.result_json);
  } catch (e) {
    console.error('[taskExport] Failed to parse result_json for doc save:', e);
    return null;
  }

  // Generate document name from prompt
  // Sanitize: keep alphanumeric, spaces, underscores; replace others with underscore
  const sanitized = task.prompt
    .slice(0, 40)
    .replace(/[^a-zA-Z0-9\s_]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');

  // Add timestamp suffix for uniqueness
  const timestamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '_');
  const name = `${sanitized || 'task_result'}_${timestamp}`;

  try {
    const doc = await createDocument({
      name,
      category: 'outputs',
      content_type: 'json',
      content: JSON.stringify(result, null, 2),
    });
    logger.log('[taskExport] Saved task result to document:', doc.id);
    return doc.id;
  } catch (e) {
    // Log but don't throw - auto-save should not block UI
    console.error('[taskExport] Failed to save task result to document:', e);
    return null;
  }
}
