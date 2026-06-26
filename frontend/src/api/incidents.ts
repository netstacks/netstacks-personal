// API client for Incidents plugin

import { getClient } from './client';
import type {
  Incident,
  IncidentComment,
  CreateIncidentInput,
  UpdateIncidentInput,
} from '../types/incidents';

// === Incidents ===

export async function listIncidents(
  page = 1,
  perPage = 50,
  filters?: Record<string, unknown>
): Promise<{ data: Incident[]; total: number }> {
  const { data } = await getClient().http.get('/plugins/incidents/admin/incidents', {
    params: { page, per_page: perPage, ...filters },
  });

  // Handle response formats: { data: [...], total } or plain array
  const list = Array.isArray(data) ? data : (data.data ?? []);
  // Map plugin field names to frontend types
  const mapped = list.map((item: Record<string, unknown>) => ({
    ...item,
    linked_alert_count: item.alert_count ?? item.linked_alert_count ?? 0,
  }));
  return { data: mapped as Incident[], total: Array.isArray(data) ? data.length : (data.total ?? list.length) };
}

export async function getIncident(id: string): Promise<Incident> {
  const { data } = await getClient().http.get(`/plugins/incidents/admin/incidents/${id}`);
  // Plugin returns { incident: {...} } wrapper
  return data.incident ?? data;
}

export async function createIncident(input: CreateIncidentInput): Promise<Incident> {
  const { data } = await getClient().http.post('/plugins/incidents/admin/incidents', input);
  return data.incident ?? data;
}

export async function updateIncident(id: string, input: UpdateIncidentInput): Promise<Incident> {
  const { data } = await getClient().http.put(`/plugins/incidents/admin/incidents/${id}`, input);
  return data.incident ?? data;
}

export async function deleteIncident(id: string): Promise<void> {
  await getClient().http.delete(`/plugins/incidents/admin/incidents/${id}`);
}

// === Incident Alerts ===

export async function linkAlert(incidentId: string, alertId: string): Promise<void> {
  await getClient().http.post(`/plugins/incidents/admin/incidents/${incidentId}/alerts`, {
    alert_id: alertId,
  });
}

export async function unlinkAlert(incidentId: string, alertId: string): Promise<void> {
  await getClient().http.delete(`/plugins/incidents/admin/incidents/${incidentId}/alerts/${alertId}`);
}

// === Incident Comments ===

export async function getComments(incidentId: string): Promise<IncidentComment[]> {
  const { data } = await getClient().http.get(`/plugins/incidents/admin/incidents/${incidentId}/comments`);
  return data.data ?? data;
}

export async function addComment(incidentId: string, body: string, userId?: string): Promise<IncidentComment> {
  const headers: Record<string, string> = {};
  if (userId) headers['X-User-Id'] = userId;
  const { data } = await getClient().http.post(`/plugins/incidents/admin/incidents/${incidentId}/comments`, {
    comment_text: body,
  }, {
    headers,
  });
  return data.comment ?? data;
}
