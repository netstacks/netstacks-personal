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
  /** The device's assigned connection profile (device-anchored default), from
   *  GET /api/devices/browse. Undefined/null = no profile assigned (connect
   *  falls back to the user's default profile). Used to pre-select/label the
   *  device default in the connect dialog. */
  profile_id?: string | null;
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
