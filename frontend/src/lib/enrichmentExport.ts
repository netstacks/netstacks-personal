import { getErrorMessage } from '../api/errors'
/**
 * Enrichment Export Utilities
 *
 * Functions to generate markdown documents from enrichment data
 * and save them to the docs system.
 */

import type { Device } from '../types/topology';
import type { DeviceEnrichment, InterfaceEnrichment, LinkEnrichment } from '../types/enrichment';
import { createDocument, type NewDocument } from '../api/docs';
import { resolveDocSaveTarget, type DocSaveSource } from './docSaveTargets';
import { formatUptime, formatBytes } from './enrichmentHelpers';

/**
 * Generate markdown content for a device's enrichment data
 */
export function generateDeviceMarkdown(
  device: Device | undefined,
  enrichment: DeviceEnrichment | undefined,
  interfaces: InterfaceEnrichment[]
): string {
  const deviceName = enrichment?.hostname || device?.name || 'Unknown Device';
  const timestamp = enrichment?.collectedAt
    ? new Date(enrichment.collectedAt).toLocaleString()
    : new Date().toLocaleString();

  // Get display values
  const vendor = enrichment?.vendor || device?.vendor || 'Unknown';
  const model = enrichment?.model || device?.model || device?.platform || 'Unknown';
  const osVersion = enrichment?.osVersion || device?.version || 'Unknown';
  const serial = enrichment?.serialNumber || device?.serial || 'N/A';
  const hostname = enrichment?.hostname || device?.name || 'Unknown';

  // Uptime
  let uptime = 'N/A';
  if (enrichment?.uptimeSeconds !== undefined) {
    uptime = formatUptime(enrichment.uptimeSeconds);
  } else if (enrichment?.uptimeFormatted) {
    uptime = enrichment.uptimeFormatted;
  } else if (device?.uptime) {
    uptime = device.uptime;
  }

  let markdown = `# Device: ${deviceName}

**Collected:** ${timestamp}

## System Information

| Field | Value |
|-------|-------|
| Vendor | ${vendor} |
| Model | ${model} |
| OS Version | ${osVersion} |
| Serial | ${serial} |
| Hostname | ${hostname} |
| Uptime | ${uptime} |
`;

  // Add CLI flavor if available
  if (enrichment?.cliFlavor) {
    markdown += `| CLI Flavor | ${enrichment.cliFlavor} |\n`;
  }

  // Resources section
  if (enrichment?.cpuPercent !== undefined || enrichment?.memoryPercent !== undefined) {
    markdown += `\n## Resources\n\n`;

    if (enrichment.cpuPercent !== undefined) {
      markdown += `- **CPU:** ${enrichment.cpuPercent.toFixed(1)}%\n`;
    }

    if (enrichment.memoryPercent !== undefined) {
      let memoryLine = `- **Memory:** ${enrichment.memoryPercent.toFixed(1)}%`;
      if (enrichment.memoryUsedMB !== undefined && enrichment.memoryTotalMB !== undefined) {
        const usedStr = formatBytes(enrichment.memoryUsedMB * 1024 * 1024);
        const totalStr = formatBytes(enrichment.memoryTotalMB * 1024 * 1024);
        memoryLine += ` (${usedStr} / ${totalStr})`;
      }
      markdown += memoryLine + '\n';
    }
  }

  // Interfaces section
  if (interfaces.length > 0) {
    markdown += `\n## Interfaces (${interfaces.length})\n\n`;
    markdown += `| Name | Status | Speed | MTU | IP | MAC |\n`;
    markdown += `|------|--------|-------|-----|-----|-----|\n`;

    for (const iface of interfaces) {
      const name = iface.name || '-';
      const status = iface.status || '-';
      const speed = iface.speed || '-';
      const mtu = iface.mtu?.toString() || '-';
      const ip = iface.ipAddress || '-';
      const mac = iface.macAddress || '-';

      markdown += `| ${name} | ${status} | ${speed} | ${mtu} | ${ip} | ${mac} |\n`;
    }

    // Add detailed interface stats if available
    const interfacesWithStats = interfaces.filter(
      (i) => i.rxPackets !== undefined || i.txPackets !== undefined
    );

    if (interfacesWithStats.length > 0) {
      markdown += `\n### Interface Statistics\n\n`;
      markdown += `| Name | RX Pkts | TX Pkts | RX Bytes | TX Bytes | RX Errors | TX Errors |\n`;
      markdown += `|------|---------|---------|----------|----------|-----------|----------|\n`;

      for (const iface of interfacesWithStats) {
        const rxPkts = iface.rxPackets?.toLocaleString() || '0';
        const txPkts = iface.txPackets?.toLocaleString() || '0';
        const rxBytes = iface.rxBytes !== undefined ? formatBytes(iface.rxBytes) : '-';
        const txBytes = iface.txBytes !== undefined ? formatBytes(iface.txBytes) : '-';
        const rxErrors = iface.rxErrors?.toString() || '0';
        const txErrors = iface.txErrors?.toString() || '0';

        markdown += `| ${iface.name} | ${rxPkts} | ${txPkts} | ${rxBytes} | ${txBytes} | ${rxErrors} | ${txErrors} |\n`;
      }
    }
  }

  // Raw outputs section (commented out by default to keep docs clean)
  if (enrichment?.rawOutputs && Object.keys(enrichment.rawOutputs).length > 0) {
    markdown += `\n## Raw Command Outputs\n\n`;
    markdown += `<details>\n<summary>Click to expand (${Object.keys(enrichment.rawOutputs).length} commands)</summary>\n\n`;

    for (const [command, output] of Object.entries(enrichment.rawOutputs)) {
      markdown += `### \`${command}\`\n\n\`\`\`\n${output}\n\`\`\`\n\n`;
    }

    markdown += `</details>\n`;
  }

  return markdown;
}

/**
 * Generate markdown content for a link's enrichment data
 */
export function generateLinkMarkdown(
  sourceDevice: Device | undefined,
  targetDevice: Device | undefined,
  linkEnrichment: LinkEnrichment,
  sourceName: string,
  targetName: string
): string {
  const timestamp = linkEnrichment.collectedAt
    ? new Date(linkEnrichment.collectedAt).toLocaleString()
    : new Date().toLocaleString();

  const sourceDisplayName = sourceDevice?.name || sourceName;
  const targetDisplayName = targetDevice?.name || targetName;

  let markdown = `# Link: ${sourceDisplayName} <-> ${targetDisplayName}

**Collected:** ${timestamp}

## Connection Overview

| Property | Source | Destination |
|----------|--------|-------------|
| Device | ${sourceDisplayName} | ${targetDisplayName} |
| Interface | ${linkEnrichment.sourceInterface.name} | ${linkEnrichment.destInterface.name} |
| Status | ${linkEnrichment.sourceInterface.status} | ${linkEnrichment.destInterface.status} |
| Speed | ${linkEnrichment.sourceInterface.speed || '-'} | ${linkEnrichment.destInterface.speed || '-'} |
| Duplex | ${linkEnrichment.sourceInterface.duplex || '-'} | ${linkEnrichment.destInterface.duplex || '-'} |
| MTU | ${linkEnrichment.sourceInterface.mtu || '-'} | ${linkEnrichment.destInterface.mtu || '-'} |

## Source Interface: ${sourceDisplayName} - ${linkEnrichment.sourceInterface.name}

`;

  markdown += generateInterfaceMarkdown(linkEnrichment.sourceInterface);

  markdown += `\n## Destination Interface: ${targetDisplayName} - ${linkEnrichment.destInterface.name}\n\n`;

  markdown += generateInterfaceMarkdown(linkEnrichment.destInterface);

  // Traffic comparison
  markdown += `\n## Traffic Summary\n\n`;
  markdown += `| Metric | ${sourceDisplayName} | ${targetDisplayName} |\n`;
  markdown += `|--------|${'-'.repeat(sourceDisplayName.length + 2)}|${'-'.repeat(targetDisplayName.length + 2)}|\n`;

  const srcRxBytes = linkEnrichment.sourceInterface.rxBytes !== undefined
    ? formatBytes(linkEnrichment.sourceInterface.rxBytes)
    : '-';
  const srcTxBytes = linkEnrichment.sourceInterface.txBytes !== undefined
    ? formatBytes(linkEnrichment.sourceInterface.txBytes)
    : '-';
  const destRxBytes = linkEnrichment.destInterface.rxBytes !== undefined
    ? formatBytes(linkEnrichment.destInterface.rxBytes)
    : '-';
  const destTxBytes = linkEnrichment.destInterface.txBytes !== undefined
    ? formatBytes(linkEnrichment.destInterface.txBytes)
    : '-';

  markdown += `| RX Bytes | ${srcRxBytes} | ${destRxBytes} |\n`;
  markdown += `| TX Bytes | ${srcTxBytes} | ${destTxBytes} |\n`;

  const srcRxPkts = linkEnrichment.sourceInterface.rxPackets?.toLocaleString() || '-';
  const srcTxPkts = linkEnrichment.sourceInterface.txPackets?.toLocaleString() || '-';
  const destRxPkts = linkEnrichment.destInterface.rxPackets?.toLocaleString() || '-';
  const destTxPkts = linkEnrichment.destInterface.txPackets?.toLocaleString() || '-';

  markdown += `| RX Packets | ${srcRxPkts} | ${destRxPkts} |\n`;
  markdown += `| TX Packets | ${srcTxPkts} | ${destTxPkts} |\n`;

  const srcRxErr = linkEnrichment.sourceInterface.rxErrors?.toString() || '0';
  const srcTxErr = linkEnrichment.sourceInterface.txErrors?.toString() || '0';
  const destRxErr = linkEnrichment.destInterface.rxErrors?.toString() || '0';
  const destTxErr = linkEnrichment.destInterface.txErrors?.toString() || '0';

  markdown += `| RX Errors | ${srcRxErr} | ${destRxErr} |\n`;
  markdown += `| TX Errors | ${srcTxErr} | ${destTxErr} |\n`;

  return markdown;
}

/**
 * Generate markdown section for a single interface
 */
function generateInterfaceMarkdown(intf: InterfaceEnrichment): string {
  let markdown = `| Property | Value |\n`;
  markdown += `|----------|-------|\n`;
  markdown += `| Name | ${intf.name} |\n`;
  markdown += `| Status | ${intf.status} |\n`;

  if (intf.description) {
    markdown += `| Description | ${intf.description} |\n`;
  }
  if (intf.speed) {
    markdown += `| Speed | ${intf.speed} |\n`;
  }
  if (intf.duplex) {
    markdown += `| Duplex | ${intf.duplex} |\n`;
  }
  if (intf.mtu) {
    markdown += `| MTU | ${intf.mtu} |\n`;
  }
  if (intf.ipAddress) {
    markdown += `| IP Address | ${intf.ipAddress} |\n`;
  }
  if (intf.macAddress) {
    markdown += `| MAC Address | ${intf.macAddress} |\n`;
  }
  if (intf.rxBytes !== undefined) {
    markdown += `| RX Bytes | ${formatBytes(intf.rxBytes)} |\n`;
  }
  if (intf.txBytes !== undefined) {
    markdown += `| TX Bytes | ${formatBytes(intf.txBytes)} |\n`;
  }
  if (intf.rxPackets !== undefined) {
    markdown += `| RX Packets | ${intf.rxPackets.toLocaleString()} |\n`;
  }
  if (intf.txPackets !== undefined) {
    markdown += `| TX Packets | ${intf.txPackets.toLocaleString()} |\n`;
  }
  if (intf.rxErrors !== undefined) {
    markdown += `| RX Errors | ${intf.rxErrors} |\n`;
  }
  if (intf.txErrors !== undefined) {
    markdown += `| TX Errors | ${intf.txErrors} |\n`;
  }

  return markdown;
}

/**
 * Save enrichment data as a markdown document
 *
 * @param content - Markdown content to save
 * @param filename - Suggested filename (will be sanitized)
 * @param category - Document category (defaults to 'notes')
 * @returns The created document
 */
export async function saveEnrichmentToDoc(
  content: string,
  filename: string,
  source: DocSaveSource = 'deviceEnrichment'
): Promise<{ success: boolean; documentId?: string; error?: string }> {
  try {
    // Sanitize filename
    const sanitizedName = filename
      .replace(/[^a-zA-Z0-9_\-. ]/g, '_')
      .replace(/\s+/g, '_')
      .replace(/_+/g, '_')
      .trim();

    const timestamp = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    const docName = `${sanitizedName}_${timestamp}.md`;

    // Resolve the user-configured category + folder for this source.
    const { category, folder } = resolveDocSaveTarget(source);

    const newDoc: NewDocument = {
      name: docName,
      category: category,
      content_type: 'markdown',
      content: content,
      parent_folder: folder,
    };

    const doc = await createDocument(newDoc);

    return {
      success: true,
      documentId: doc.id,
    };
  } catch (error) {
    console.error('Failed to save enrichment to docs:', error);
    return {
      success: false,
      error: getErrorMessage(error),
    };
  }
}

/**
 * Helper to save device enrichment as a document
 */
export async function saveDeviceEnrichmentToDoc(
  device: Device | undefined,
  enrichment: DeviceEnrichment | undefined,
  interfaces: InterfaceEnrichment[]
): Promise<{ success: boolean; documentId?: string; error?: string }> {
  const deviceName = enrichment?.hostname || device?.name || 'unknown_device';
  const markdown = generateDeviceMarkdown(device, enrichment, interfaces);
  return saveEnrichmentToDoc(markdown, `device_${deviceName}`);
}

/**
 * Helper to save link enrichment as a document
 */
export async function saveLinkEnrichmentToDoc(
  sourceDevice: Device | undefined,
  targetDevice: Device | undefined,
  linkEnrichment: LinkEnrichment,
  sourceName: string,
  targetName: string
): Promise<{ success: boolean; documentId?: string; error?: string }> {
  const markdown = generateLinkMarkdown(
    sourceDevice,
    targetDevice,
    linkEnrichment,
    sourceName,
    targetName
  );
  const filename = `link_${sourceName}_to_${targetName}`;
  return saveEnrichmentToDoc(markdown, filename, 'linkEnrichment');
}
