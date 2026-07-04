/**
 * topologyFilters — view-only visibility filtering for the topology editor.
 *
 * A device passes if it satisfies BOTH the discovery axis (managed vs.
 * LLDP/CDP neighbor) and the status axis. Filtering never mutates the source
 * topology; it returns a shallow-cloned copy for rendering only.
 */
import type { Device, Topology, DeviceFilterState } from '../types/topology'

/**
 * True if the device should be shown under the given filters.
 */
export function isDeviceVisible(device: Device, filters: DeviceFilterState): boolean {
  const discoveryOk = device.isNeighbor
    ? filters.discovery.neighbors
    : filters.discovery.managed
  if (!discoveryOk) return false
  return filters.status[device.status] ?? true
}

/**
 * Return a new topology containing only visible devices and only connections
 * whose both endpoints are visible. Input is not mutated.
 */
export function filterTopology(topology: Topology, filters: DeviceFilterState): Topology {
  const visibleDevices = topology.devices.filter(d => isDeviceVisible(d, filters))
  const visibleIds = new Set(visibleDevices.map(d => d.id))
  const visibleConnections = topology.connections.filter(
    c => visibleIds.has(c.sourceDeviceId) && visibleIds.has(c.targetDeviceId),
  )
  return { ...topology, devices: visibleDevices, connections: visibleConnections }
}
