export interface DeviceMemory {
  id: string;
  session_id: string;
  role: string | null;
  criticality: 'low' | 'medium' | 'high' | 'critical' | null;
  standing_instructions: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface DeviceMemoryEntry {
  id: string;
  device_memory_id: string;
  date: string;
  source: 'manual' | 'troubleshooting' | 'overlord';
  author: string;
  content: string;
  created_at: string;
  updated_at: string;
}

export interface DeviceMemoryWithEntries extends DeviceMemory {
  entries: DeviceMemoryEntry[];
}

export interface NewDeviceMemoryEntry {
  date: string;
  source: 'manual' | 'troubleshooting' | 'overlord';
  author: string;
  content: string;
}

export interface UpdateDeviceMemory {
  role?: string | null;
  criticality?: 'low' | 'medium' | 'high' | 'critical' | null;
  standing_instructions?: string | null;
  notes?: string | null;
}

export interface UpdateDeviceMemoryEntry {
  date?: string;
  content?: string;
}
