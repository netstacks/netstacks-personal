// API client for terminal recordings (asciicast v2 format)

import { getClient } from './client';

export interface Recording {
  id: string;
  session_id: string | null;
  name: string;
  terminal_cols: number;
  terminal_rows: number;
  duration_ms: number;
  file_path: string;
  created_at: string;
  updated_at: string;
}

export interface NewRecording {
  session_id?: string | null;
  name: string;
  terminal_cols?: number;
  terminal_rows?: number;
}

export interface UpdateRecording {
  name?: string;
  duration_ms?: number;
}

// List every recording (newest first per backend ordering).
export async function listRecordings(): Promise<Recording[]> {
  const { data } = await getClient().http.get('/recordings');
  return Array.isArray(data) ? data : [];
}

// Get a single recording
export async function getRecording(id: string): Promise<Recording> {
  const { data } = await getClient().http.get(`/recordings/${id}`);
  return data;
}

// Delete a recording (removes the DB row and the on-disk asciicast file).
export async function deleteRecording(id: string): Promise<void> {
  await getClient().http.delete(`/recordings/${id}`);
}

// Rename a recording in-place (no other fields).
export async function renameRecording(id: string, name: string): Promise<Recording> {
  return updateRecording(id, { name });
}

// Create a new recording
export async function createRecording(recording: NewRecording): Promise<Recording> {
  const { data } = await getClient().http.post('/recordings', recording);
  return data;
}

// Update a recording
export async function updateRecording(id: string, update: UpdateRecording): Promise<Recording> {
  const { data } = await getClient().http.put(`/recordings/${id}`, update);
  return data;
}

// Get recording data (asciicast file content)
export async function getRecordingData(id: string): Promise<string> {
  const { data } = await getClient().http.get(`/recordings/${id}/data`);
  return data;
}

// Append data to a recording
export async function appendRecordingData(id: string, data: string): Promise<void> {
  await getClient().http.post(`/recordings/${id}/append`, { data });
}

/**
 * Recording capture manager for terminals.
 * Captures terminal output in asciicast v2 format.
 */
export class RecordingCapture {
  private recordingId: string | null = null;
  private startTime: number = 0;
  private buffer: string[] = [];
  private flushInterval: number | null = null;
  private isActive: boolean = false;

  /**
   * Start capturing terminal output.
   * @param name Recording name
   * @param cols Terminal columns
   * @param rows Terminal rows
   * @param sessionId Optional session ID to associate with recording
   */
  async start(name: string, cols: number, rows: number, sessionId?: string): Promise<string> {
    if (this.isActive) {
      throw new Error('Recording already in progress');
    }

    // Create recording on backend
    const recording = await createRecording({
      name,
      terminal_cols: cols,
      terminal_rows: rows,
      session_id: sessionId,
    });

    this.recordingId = recording.id;
    this.startTime = performance.now();
    this.buffer = [];
    this.isActive = true;

    // Start periodic flush (every 2 seconds)
    this.flushInterval = window.setInterval(() => {
      this.flush();
    }, 2000);

    return recording.id;
  }

  /**
   * Add output data to the recording.
   * @param data Terminal output data
   */
  addOutput(data: string): void {
    if (!this.isActive || !this.recordingId) return;

    // Calculate time offset from start in seconds
    const timeOffset = (performance.now() - this.startTime) / 1000;

    // Format as asciicast v2 event: [time, "o", data]
    const event = JSON.stringify([timeOffset, 'o', data]);
    this.buffer.push(event + '\n');
  }

  /**
   * Add input data to the recording.
   * @param data Terminal input data
   */
  addInput(data: string): void {
    if (!this.isActive || !this.recordingId) return;

    // Calculate time offset from start in seconds
    const timeOffset = (performance.now() - this.startTime) / 1000;

    // Format as asciicast v2 event: [time, "i", data]
    const event = JSON.stringify([timeOffset, 'i', data]);
    this.buffer.push(event + '\n');
  }

  /**
   * Flush buffered data to the backend.
   */
  async flush(): Promise<void> {
    if (!this.recordingId || this.buffer.length === 0) return;

    const data = this.buffer.join('');
    this.buffer = [];

    try {
      await appendRecordingData(this.recordingId, data);
    } catch (err) {
      console.error('Failed to flush recording buffer:', err);
      // Re-add data to buffer on failure
      this.buffer.unshift(data);
    }
  }

  /**
   * Stop capturing and finalize the recording.
   * @returns The recording ID
   */
  async stop(): Promise<string | null> {
    if (!this.isActive || !this.recordingId) {
      return null;
    }

    // Stop flush interval
    if (this.flushInterval) {
      window.clearInterval(this.flushInterval);
      this.flushInterval = null;
    }

    // Final flush
    await this.flush();

    // Calculate duration
    const durationMs = Math.round(performance.now() - this.startTime);

    // Update recording with final duration
    await updateRecording(this.recordingId, { duration_ms: durationMs });

    const recordingId = this.recordingId;

    // Reset state
    this.recordingId = null;
    this.startTime = 0;
    this.buffer = [];
    this.isActive = false;

    return recordingId;
  }

  /**
   * Check if recording is active.
   */
  get recording(): boolean {
    return this.isActive;
  }

  /**
   * Get the current recording ID.
   */
  get currentRecordingId(): string | null {
    return this.recordingId;
  }
}
