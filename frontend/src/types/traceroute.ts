/**
 * Traceroute data types for path visualization
 * Used to parse traceroute/tracert output and overlay paths on topology canvas
 */

/**
 * A single hop in a traceroute
 */
export interface TracerouteHop {
  /** Hop number (1-based) */
  hopNumber: number;
  /** IP address of the hop, null if timeout (*) */
  ip: string | null;
  /** Hostname if resolved */
  hostname?: string;
  /** Round-trip times in ms for each probe, null for timeout probes */
  rttMs: (number | null)[];
  /** Whether this hop timed out completely (all probes failed) */
  isTimeout: boolean;
  /** Packet loss percentage (MTR only) */
  lossPercent?: number;
  /** Best RTT in ms (MTR only) */
  bestMs?: number;
  /** Worst RTT in ms (MTR only) */
  wrstMs?: number;
}

/**
 * Complete traceroute result from parsing output
 */
export interface TracerouteResult {
  /** Unique identifier for this traceroute */
  id: string;
  /** Destination hostname or IP */
  destination: string;
  /** Resolved destination IP if different from destination */
  destinationIp?: string;
  /** When the traceroute was captured */
  timestamp: string;
  /** All hops in order */
  hops: TracerouteHop[];
  /** Whether the traceroute reached the destination */
  complete: boolean;
  /** Error message if traceroute failed */
  error?: string;
}

/**
 * Traceroute path with device matching for visualization
 */
export interface TraceroutePath {
  /** The parsed traceroute result */
  traceroute: TracerouteResult;
  /** Device ID for each hop index, null if no matching device in topology */
  matchedDeviceIds: (string | null)[];
  /** Connection IDs that form the path between matched devices */
  highlightedConnectionIds: string[];
}
