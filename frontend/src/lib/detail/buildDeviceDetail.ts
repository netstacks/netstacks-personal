/**
 * Device detail composer and provider registry
 */

import type { Device } from '../../types/topology';
import type { DetailSection, DeviceDetailContext, DeviceDetailProvider } from './types';
import { identityProvider } from './providers/identity';
import { connectivityProvider } from './providers/connectivity';
import { liveProvider } from './providers/live';
import { enrichmentProvider } from './providers/enrichment';
import { tracerouteProvider } from './providers/traceroute';

/**
 * Internal base provider array
 * Seeded with base providers in later tasks
 */
const deviceProviders: DeviceDetailProvider[] = [
  identityProvider,
  connectivityProvider,
  liveProvider,
  enrichmentProvider,
  tracerouteProvider,
];

/**
 * Registered additional providers
 */
const registeredProviders: DeviceDetailProvider[] = [];

/**
 * Register an additional device detail provider
 * (e.g., enterprise crawler/issues/history)
 */
export function registerDeviceDetailProvider(p: DeviceDetailProvider): void {
  registeredProviders.push(p);
}

/**
 * Normalize sections:
 * 1. Drop fields with empty/N/A/Unknown values (case-insensitive)
 * 2. Merge sections sharing the same id (concatenate fields in first-seen order)
 * 3. Drop sections left with no fields
 * 4. Stable sort by priority (ascending)
 */
export function normalizeSections(sections: DetailSection[]): DetailSection[] {
  // Step 1: Drop empty fields from each section
  const withoutEmpties = sections.map(section => ({
    ...section,
    fields: section.fields.filter(field => {
      const value = field.value.toLowerCase();
      return value !== '' && value !== 'n/a' && value !== 'unknown';
    }),
  }));

  // Step 2: Merge sections with the same id
  const mergedMap = new Map<string, DetailSection>();
  for (const section of withoutEmpties) {
    const existing = mergedMap.get(section.id);
    if (existing) {
      // Merge fields (first-seen order)
      existing.fields.push(...section.fields);
    } else {
      // First occurrence
      mergedMap.set(section.id, { ...section });
    }
  }

  // Step 3: Drop sections with no fields
  const withFields = Array.from(mergedMap.values()).filter(
    section => section.fields.length > 0
  );

  // Step 4: Stable sort by priority (ascending)
  return withFields.sort((a, b) => a.priority - b.priority);
}

/**
 * Build device detail sections from all providers
 * Runs base providers + registered providers, then normalizes
 */
export function buildDeviceDetail(
  device: Device,
  ctx: DeviceDetailContext
): DetailSection[] {
  const allProviders = [...deviceProviders, ...registeredProviders];
  const allSections = allProviders.flatMap(provider => provider(device, ctx));
  return normalizeSections(allSections);
}
