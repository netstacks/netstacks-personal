// MOP Test Terminal API — execute commands on devices for MOP testing
// Enterprise mode: POST /api/devices/{deviceId}/exec-command (controller)
// Standalone mode: POST /ai/ssh-execute (sidecar, using session ID as target)

import { getClient, getCurrentMode } from './client';

export interface ExecCommandResult {
  success: boolean;
  output: string;
  error?: string;
  execution_time_ms: number;
}

/**
 * Execute a command on a device for MOP testing.
 * In enterprise mode, calls the controller's device exec-command endpoint.
 * In standalone mode, calls the sidecar's AI SSH execute endpoint.
 */
export async function execMopCommand(
  deviceId: string,
  command: string,
  timeoutSecs?: number
): Promise<ExecCommandResult> {
  const client = getClient();
  const mode = getCurrentMode();

  try {
    if (mode === 'enterprise') {
      const res = await client.http.post(`/devices/${deviceId}/exec-command`, {
        command,
        timeout_secs: timeoutSecs ?? 30,
      });
      return res.data;
    } else {
      const res = await client.http.post('/ai/ssh-execute', {
        session_id: deviceId,
        command,
        timeout_secs: timeoutSecs ?? 30,
      });
      return res.data;
    }
  } catch (err: any) {
    if (err?.response?.data) {
      return err.response.data as ExecCommandResult;
    }
    return {
      success: false,
      output: '',
      error: err?.message || String(err),
      execution_time_ms: 0,
    };
  }
}
