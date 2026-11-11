/**
 * Session-IP-authoritative SNMP host resolver.
 *
 * The rule: when a topology node's name matches a session whose hostname
 * we know, the session's `host` is the authoritative SNMP IP. CDP/LLDP-
 * advertised loopback IPs (e.g. 10.255.x.x) often aren't actually
 * SNMP-reachable from the user's network, so we override them whenever
 * we have a session-derived alternative.
 *
 * Used at SNMP-poll sites (DeviceDetailTab, LinkDetailTab) so existing
 * topology entries with stale loopback `primary_ip` values still poll
 * correctly without requiring a re-discovery.
 */

import type { DeviceEnrichment } from '../types/enrichment';
import type { Session } from '../api/sessions';

/**
 * Resolve the SNMP host for a device. If the device's name matches a
 * known session hostname (via EnrichmentContext), prefer the session's
 * `host`. Otherwise return the supplied `currentHost` unchanged.
 *
 * @param deviceName  The topology node's name (often a discovered sysName).
 * @param currentHost The host currently stored on the device record.
 * @param enrichments The deviceEnrichments map from useEnrichment().
 * @param sessionsById The chipSessionsById Map<sessionId, Session>.
 */
export function resolveSnmpHost(
  deviceName: string | undefined | null,
  currentHost: string | undefined | null,
  enrichments: ReadonlyMap<string, DeviceEnrichment>,
  sessionsById: ReadonlyMap<string, Session>,
): string | undefined {
  const fallback = currentHost || undefined;
  if (!deviceName) return fallback;
  const key = deviceName.toLowerCase().trim();
  if (!key) return fallback;

  for (const enr of enrichments.values()) {
    if (!enr.hostname) continue;
    if (enr.hostname.toLowerCase().trim() !== key) continue;
    const session = sessionsById.get(enr.sessionId);
    if (session?.host) return session.host;
  }

  return fallback;
}
