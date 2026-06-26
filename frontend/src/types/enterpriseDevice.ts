/**
 * Device types for Enterprise mode device inventory browsing
 * Phase 42.2: Device Inventory in Enterprise Mode
 */

export interface DeviceSummary {
  id: string;
  org_id: string;
  name: string;
  host: string;
  port: number;
  device_type: string;
  manufacturer: string | null;
  model: string | null;
  site: string | null;
  source: string;
  default_credential_id?: string | null;
  snmp_credential_id?: string | null;
  connect_commands?: string[];
  created_at: string;
  updated_at: string;
}

export interface ListDevicesResponse {
  items: DeviceSummary[];
  total: number;
  limit: number;
  offset: number;
}

export interface ListDevicesParams {
  limit?: number;
  offset?: number;
  source?: string;
  device_type?: string;
  site?: string;
}
