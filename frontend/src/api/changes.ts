import type { Change, NewChange, UpdateChange, Snapshot, NewSnapshot } from '../types/change';
import { getClient } from './client';

// Changes CRUD

export async function listChanges(sessionId?: string): Promise<Change[]> {
  const params: Record<string, string> = {};
  if (sessionId) params.session_id = sessionId;

  const { data } = await getClient().http.get('/changes', { params });
  return data;
}

export async function getChange(id: string): Promise<Change> {
  const { data } = await getClient().http.get(`/changes/${id}`);
  return data;
}

export async function createChange(change: NewChange): Promise<Change> {
  const { data } = await getClient().http.post('/changes', change);
  return data;
}

export async function updateChange(id: string, update: UpdateChange): Promise<Change> {
  const { data } = await getClient().http.put(`/changes/${id}`, update);
  return data;
}

export async function deleteChange(id: string): Promise<void> {
  await getClient().http.delete(`/changes/${id}`);
}

// Change workflow actions

export async function startChange(id: string): Promise<Change> {
  return updateChange(id, { status: 'executing', executed_at: new Date().toISOString() });
}

export async function completeChange(id: string, analysis?: string): Promise<Change> {
  return updateChange(id, {
    status: 'complete',
    ai_analysis: analysis,
    completed_at: new Date().toISOString()
  });
}

export async function failChange(id: string, analysis?: string): Promise<Change> {
  return updateChange(id, {
    status: 'failed',
    ai_analysis: analysis,
    completed_at: new Date().toISOString()
  });
}

export async function rollbackChange(id: string): Promise<Change> {
  return updateChange(id, {
    status: 'rolled_back',
    completed_at: new Date().toISOString()
  });
}

// Snapshots

export async function listSnapshots(changeId: string): Promise<Snapshot[]> {
  const { data } = await getClient().http.get(`/changes/${changeId}/snapshots`);
  return data;
}

export async function getSnapshot(id: string): Promise<Snapshot> {
  const { data } = await getClient().http.get(`/snapshots/${id}`);
  return data;
}

export async function createSnapshot(snapshot: NewSnapshot): Promise<Snapshot> {
  const { data } = await getClient().http.post('/snapshots', snapshot);
  return data;
}

export async function deleteSnapshot(id: string): Promise<void> {
  await getClient().http.delete(`/snapshots/${id}`);
}
