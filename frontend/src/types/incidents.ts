// Type definitions for Incidents and Alerts plugins

export type AlertSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';
export type AlertState = 'active' | 'open' | 'acknowledged' | 'resolved' | 'suppressed';
export type IncidentState = 'open' | 'acknowledged' | 'in_progress' | 'resolved' | 'closed';
export type IncidentSeverity = 'critical' | 'high' | 'medium' | 'low';
export type TriageState = 'pending' | 'routing' | 'triaging' | 'triaged' | 'resolved' | 'escalated' | 'pending_mop' | 'pending_review' | 'failed' | 'skipped';
export type TriageEventType = 'ingested' | 'deduplicated' | 'routing_matched' | 'routing_skipped' | 'agent_started' | 'tool_call' | 'tool_result' | 'observation' | 'knowledge_hit' | 'correlation' | 'action_taken' | 'decision' | 'resolved' | 'agent_completed' | 'agent_failed' | 'escalated' | 'mop_created' | 'incident_created' | 'human_review' | 'handoff' | 'ephemeral_created';

export interface Alert {
  id: string;
  fingerprint: string;
  title: string;
  description: string | null;
  severity: AlertSeverity;
  state: AlertState;
  source: string;
  source_ref: string | null;
  device_id: string | null;
  raw_payload: Record<string, unknown> | null;
  triage_state: TriageState | null;
  triage_agent_id: string | null;
  execution_id: string | null;
  root_cause: string | null;
  impact_summary: string | null;
  resolution: string | null;
  incident_id: string | null;
  mop_id: string | null;
  correlated_with: string | null;
  resolved_by_agent: boolean | null;
  occurrence_count: number;
  first_seen_at: string;
  last_seen_at: string;
  created_at: string;
  updated_at: string;
}

export interface Incident {
  id: string;
  title: string;
  description: string | null;
  severity: IncidentSeverity;
  state: IncidentState;
  created_from: string | null;
  created_by: string | null;
  resolved_at: string | null;
  resolved_by: string | null;
  itsm_provider: string | null;
  itsm_ref: string | null;
  linked_alert_count: number;
  alerts?: IncidentAlert[];
  created_at: string;
  updated_at: string;
}

export interface IncidentAlert {
  alert_id: string;
  alert_title: string | null;
  alert_severity: AlertSeverity;
  alert_state: AlertState;
  linked_at: string;
}

export interface IncidentComment {
  id: string;
  incident_id: string;
  user_id: string;
  body: string;
  created_at: string;
}

export interface TriageEvent {
  id: string;
  alert_id: string;
  event_type: TriageEventType;
  summary: string;
  detail: Record<string, unknown> | null;
  duration_ms: number | null;
  created_at: string;
}

export interface CreateIncidentInput {
  title: string;
  description?: string;
  severity: IncidentSeverity;
}

export interface UpdateIncidentInput {
  title?: string;
  description?: string;
  severity?: IncidentSeverity;
  state?: IncidentState;
}
