// API client for Alerts plugin

import { getClient } from './client';
import type { Alert, TriageEvent } from '../types/incidents';

/**
 * Normalize alert response from plugin API to match frontend type expectations.
 * Handles field name variations and type conversions.
 */
function normalizeAlert(raw: Record<string, unknown>): Alert {
  let rawPayload: Record<string, unknown> = {};
  if (raw.details) {
    try {
      rawPayload = typeof raw.details === 'string' ? JSON.parse(raw.details as string) : raw.details as Record<string, unknown>;
    } catch {
      rawPayload = {};
    }
  }

  return {
    ...(raw as unknown as Alert),
    title: (raw.title ?? raw.summary ?? '') as string,
    description: (raw.description ?? raw.summary ?? '') as string,
    raw_payload: rawPayload,
    first_seen_at: (raw.first_seen_at ?? raw.first_occurrence_at ?? raw.created_at) as string,
    last_seen_at: (raw.last_seen_at ?? raw.last_occurrence_at ?? raw.updated_at) as string,
    source_ref: (raw.source_ref ?? null) as string | null,
    resolved_by_agent: (raw.resolved_by_agent ?? null) as boolean | null,
  };
}

// === Alerts ===

export async function listAlerts(
  page = 1,
  perPage = 50,
  filters?: Record<string, unknown>
): Promise<{ data: Alert[]; total: number }> {
  const { data } = await getClient().http.get('/plugins/alerts/admin/alerts', {
    params: { page, per_page: perPage, ...filters },
  });

  // Handle both response formats: { data: [...], total } and plain array
  if (Array.isArray(data)) {
    return { data: data.map(normalizeAlert), total: data.length };
  }
  return {
    data: (data.data ?? []).map(normalizeAlert),
    total: data.total ?? 0,
  };
}

export async function getAlert(id: string): Promise<Alert> {
  const { data } = await getClient().http.get(`/plugins/alerts/admin/alerts/${id}`);
  return normalizeAlert(data);
}

// Plugin uses PUT with state update body (not separate action endpoints)
export async function acknowledgeAlert(id: string, _comment?: string): Promise<Alert> {
  const { data } = await getClient().http.put(`/plugins/alerts/admin/alerts/${id}`, {
    state: 'acknowledged',
  });
  return normalizeAlert(data);
}

export async function resolveAlert(id: string, _resolution?: string): Promise<Alert> {
  const { data } = await getClient().http.put(`/plugins/alerts/admin/alerts/${id}`, {
    state: 'resolved',
  });
  return normalizeAlert(data);
}

export async function suppressAlert(
  id: string,
  durationMinutes: number,
  _reason: string
): Promise<Alert> {
  const suppressed_until = new Date(
    Date.now() + durationMinutes * 60 * 1000
  ).toISOString();
  const { data } = await getClient().http.put(`/plugins/alerts/admin/alerts/${id}`, {
    state: 'suppressed',
    suppressed_until,
  });
  return normalizeAlert(data);
}

// === Triage Events ===

export async function getTriageEvents(alertId: string): Promise<TriageEvent[]> {
  // Alerts plugin exposes triage events at /admin/triage-events/:alert_id
  // (not nested under /admin/alerts/:id) — matches admin-ui pipeline.ts and the
  // incidents plugin's own call.
  const { data } = await getClient().http.get(`/plugins/alerts/admin/triage-events/${alertId}`);
  return data.data ?? data;
}
