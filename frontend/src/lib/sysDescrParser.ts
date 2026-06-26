/**
 * Best-effort vendor / model / OS-version extraction from SNMP `sysDescr`
 * (OID `1.3.6.1.2.1.1.1.0`).
 *
 * Each network OS has its own format, so we test specific patterns in order
 * of specificity. Returns whatever fields could be identified; missing
 * fields are simply absent (use `||` chains in the caller).
 *
 * Used by:
 *   - DeviceDetailTab, when no `enrichment` prop is supplied (e.g. device tab
 *     opened directly from a session, no topology context)
 *   - Discovery → EnrichmentContext hydration in App.tsx
 */
export interface ParsedSysDescr {
  vendor?: string;
  model?: string;
  osVersion?: string;
}

export function parseSysDescr(descr: string | undefined | null): ParsedSysDescr {
  if (!descr) return {};

  // Cisco IOS / IOS-XE — `Cisco IOS Software, C3750E Software (C3750E-UNIVERSALK9-M), Version 15.2(4)E10, ...`
  const ciscoIos = /^Cisco IOS(?: XE)? Software,\s+(\S+)\s+Software\s*\([\w-]+\),\s+Version\s+([\w.()\\-]+?)[,\s]/.exec(descr);
  if (ciscoIos) {
    return { vendor: 'Cisco', model: ciscoIos[1], osVersion: ciscoIos[2] };
  }

  // Cisco IOS-XR — `Cisco IOS XR Software, Version 6.6.3 ...`
  const ciscoXr = /^Cisco IOS XR Software,\s+Version\s+([\w.]+)/.exec(descr);
  if (ciscoXr) {
    return { vendor: 'Cisco', osVersion: ciscoXr[1] };
  }

  // Cisco Nexus / NX-OS — `Cisco Nexus Operating System (NX-OS) Software ... System version: 9.3(8)`
  const ciscoNx = /Cisco Nexus.*?(?:System version|version)[:\s]+([\w.()]+)/i.exec(descr);
  if (ciscoNx) {
    return { vendor: 'Cisco', osVersion: ciscoNx[1] };
  }

  // Juniper — `Juniper Networks, Inc. mx240 internet router, kernel JUNOS 18.4R3, ...`
  const juniper = /^Juniper Networks.*?\s(\S+)\s+\w+ router,\s+kernel\s+JUNOS\s+([\w.]+)/.exec(descr);
  if (juniper) {
    return { vendor: 'Juniper', model: juniper[1], osVersion: juniper[2] };
  }

  // Arista — `Arista Networks EOS version 4.21.0F running on an Arista Networks DCS-7050QX-32`
  const arista = /^Arista Networks EOS version\s+(\S+)\s+running on an Arista Networks\s+(\S+)/.exec(descr);
  if (arista) {
    return { vendor: 'Arista', model: arista[2], osVersion: arista[1] };
  }

  // Generic Linux — `Linux <hostname> 5.4.0-... #1 SMP ... GNU/Linux`
  const linux = /^Linux\s+\S+\s+(\S+)/.exec(descr);
  if (linux) {
    return { vendor: 'Linux', osVersion: linux[1] };
  }

  // Unknown format — try to at least pull a vendor word, then a generic
  // `Version X.Y.Z` pattern as a last resort.
  const out: ParsedSysDescr = {};
  const vendorWord = /\b(Cisco|Juniper|Arista|Nokia|Alcatel|Huawei|Palo\s*Alto|Fortinet|MikroTik|Ubiquiti|Aruba|Brocade|Mellanox|Nvidia|Dell|HP|Hewlett.Packard|Microsoft|Linux)\b/i.exec(descr);
  if (vendorWord) {
    out.vendor = vendorWord[1].replace(/\s+/g, ' ').replace(/Hewlett.Packard/i, 'HP');
  }
  const versionAny = /(?:Version|version|ver\.?)\s+([\d][\w.()-]*)/i.exec(descr);
  if (versionAny) {
    out.osVersion = versionAny[1];
  }
  return out;
}
