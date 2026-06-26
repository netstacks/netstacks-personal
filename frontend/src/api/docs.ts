// API client for documents (outputs, templates, notes, backups, history)

import { getClient } from './client';

// Document category types
export type DocumentCategory = 'outputs' | 'templates' | 'notes' | 'backups' | 'history' | 'troubleshooting' | 'mops';

// Content type for smart rendering
export type ContentType = 'csv' | 'json' | 'jinja' | 'config' | 'text' | 'markdown' | 'recording';

// Document interface matching backend model
export interface Document {
  id: string;
  name: string;
  category: DocumentCategory;
  content_type: ContentType;
  content: string;
  parent_folder: string | null;
  session_id: string | null;
  created_at: string;
  updated_at: string;
  /** True if this document is encrypted at rest (Secure Notes). */
  encrypted?: boolean;
  /** True if encrypted but vault was locked when read; `content` is empty. */
  locked?: boolean;
}

/** Categories whose contents are stored encrypted in the vault. */
export const SECURE_CATEGORIES: ReadonlySet<DocumentCategory> = new Set(['notes']);
export function isSecureCategory(category: DocumentCategory): boolean {
  return SECURE_CATEGORIES.has(category);
}

// Request to create a new document
export interface NewDocument {
  name: string;
  category: DocumentCategory;
  content_type: ContentType;
  content: string;
  parent_folder?: string | null;
  session_id?: string | null;
}

// Request to update a document
export interface UpdateDocument {
  name?: string;
  category?: DocumentCategory;
  content_type?: ContentType;
  content?: string;
  parent_folder?: string | null;
  session_id?: string | null;
}

// List all documents with optional filters
export async function listDocuments(
  category?: DocumentCategory,
  parentFolder?: string
): Promise<Document[]> {
  const params = new URLSearchParams();
  if (category) params.set('category', category);
  if (parentFolder) params.set('parent_folder', parentFolder);

  const query = params.toString();
  const { data } = await getClient().http.get(`/docs${query ? `?${query}` : ''}`);
  return data;
}

// Get a single document by ID
export async function getDocument(id: string): Promise<Document> {
  const { data } = await getClient().http.get(`/docs/${id}`);
  return data;
}

// Create a new document
export async function createDocument(doc: NewDocument): Promise<Document> {
  const { data } = await getClient().http.post('/docs', doc);
  return data;
}

// Update an existing document
export async function updateDocument(
  id: string,
  doc: UpdateDocument
): Promise<Document> {
  const { data } = await getClient().http.put(`/docs/${id}`, doc);
  return data;
}

// Delete a document
export async function deleteDocument(id: string): Promise<void> {
  await getClient().http.delete(`/docs/${id}`);
}

// === Version History API ===

// Document version metadata (without content)
export interface DocumentVersionMeta {
  id: string;
  document_id: string;
  created_at: string;
}

// Full document version (with content)
export interface DocumentVersion {
  id: string;
  document_id: string;
  content: string;
  created_at: string;
}

// List all versions of a document (metadata only)
export async function listVersions(documentId: string): Promise<DocumentVersionMeta[]> {
  const { data } = await getClient().http.get(`/docs/${documentId}/versions`);
  return data;
}

// Get a specific version with full content
export async function getVersion(versionId: string): Promise<DocumentVersion> {
  const { data } = await getClient().http.get(`/docs/versions/${versionId}`);
  return data;
}

// Restore a document to a previous version
export async function restoreVersion(
  documentId: string,
  versionId: string
): Promise<Document> {
  const { data } = await getClient().http.post(`/docs/${documentId}/restore/${versionId}`);
  return data;
}

// === Template Rendering API ===

// Response from rendering a template
export interface RenderTemplateResponse {
  output: string;
  success: boolean;
  error: string | null;
}

// Render a Jinja template with provided variables
export async function renderTemplate(
  documentId: string,
  variables: Record<string, unknown>
): Promise<RenderTemplateResponse> {
  const { data } = await getClient().http.post(`/docs/${documentId}/render`, { variables });
  return data;
}
