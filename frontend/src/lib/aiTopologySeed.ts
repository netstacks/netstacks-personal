/**
 * aiTopologySeed - builds seed prompts for "Ask AI" topology entry points
 *
 * Produces a first-person user message seeded with concrete state from the
 * active-topology store (whole map | a device | a link), so the AI starts a
 * conversation already grounded in real data instead of asking the user to
 * describe the map. Handles an empty topology and missing telemetry.
 */
import { useActiveTopologyStore } from '../stores/activeTopologyStore'

export function buildTopologySeed(kind: 'map' | 'device' | 'link', targetId?: string): string {
  const s = useActiveTopologyStore.getState()
  const topo = s.topology
  if (!topo) {
    return "I'm looking at the topology view but there's no topology loaded. Help me get started."
  }

  if (kind === 'device' && targetId) {
    const d = topo.devices.find(x => x.id === targetId)
    const statsKey = d?.primaryIp || d?.name
    const stats = s.deviceStats && statsKey ? s.deviceStats.get(statsKey) : undefined
    const health = stats
      ? ` Live health is ${stats.healthScore}/100 (${stats.healthColor}), ${stats.interfaceSummary.up} up / ${stats.interfaceSummary.down} down, ${stats.interfaceSummary.totalInErrors + stats.interfaceSummary.totalOutErrors} interface errors.`
      : ''
    return `Tell me about device "${d?.name ?? targetId}" in this topology and flag any problems.${health} Use the topology tools (topology_analyze health) for live detail.`
  }

  if (kind === 'link' && targetId) {
    const c = topo.connections.find(x => x.id === targetId)
    const src = topo.devices.find(d => d.id === c?.sourceDeviceId)?.name
    const dst = topo.devices.find(d => d.id === c?.targetDeviceId)?.name
    return `Why is the link ${src ?? '?'} ⇄ ${dst ?? '?'} (${c?.sourceInterface ?? '?'} / ${c?.targetInterface ?? '?'}) showing errors? Use the live interface counters (topology_analyze health) and tell me the likely cause and the next checks to run.`
  }

  const nd = topo.devices.length
  const nc = topo.connections.length
  return `Let's discuss this topology (${nd} device${nd === 1 ? '' : 's'}, ${nc} link${nc === 1 ? '' : 's'}). Give me a health summary — call out anything down, degraded, or with interface errors, and what to investigate first.`
}
