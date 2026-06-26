/**
 * Runtime context variable resolver for MOP step execution.
 * Resolves {{device.*}} and {{steps.N.output}} placeholders in step variables.
 */

export interface DeviceContext {
  host: string;
  name: string;
  type?: string;
}

export interface StepContext {
  order: number;
  output?: string;
}

/**
 * Resolve runtime context variables in a string.
 * Supported patterns:
 *   {{device.host}}  - Current device IP/hostname
 *   {{device.name}}  - Current device display name
 *   {{device.type}}  - Netmiko device type
 *   {{steps.N.output}} - Output from step N (by order number)
 */
export function resolveVariable(
  template: string,
  device: DeviceContext,
  steps: StepContext[],
): string {
  return template.replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, (_match, path: string) => {
    const parts = path.split('.');

    if (parts[0] === 'device') {
      switch (parts[1]) {
        case 'host': return device.host;
        case 'name': return device.name;
        case 'type': return device.type || '';
        default: return _match;
      }
    }

    if (parts[0] === 'steps' && parts.length >= 3) {
      const stepOrder = parseInt(parts[1], 10);
      if (isNaN(stepOrder)) return _match;
      const step = steps.find(s => s.order === stepOrder);
      if (!step) return _match;
      if (parts[2] === 'output') return step.output || '';
      return _match;
    }

    return _match;
  });
}

/**
 * Resolve all variables in a Record<string, string> (quick_action_variables).
 */
export function resolveVariables(
  variables: Record<string, string>,
  device: DeviceContext,
  steps: StepContext[],
): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(variables)) {
    resolved[key] = resolveVariable(value, device, steps);
  }
  return resolved;
}

/**
 * Resolve all values in a Record<string, unknown> (script_args).
 * Only resolves string values; non-string values pass through unchanged.
 */
export function resolveArgs(
  args: Record<string, unknown>,
  device: DeviceContext,
  steps: StepContext[],
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === 'string') {
      resolved[key] = resolveVariable(value, device, steps);
    } else {
      resolved[key] = value;
    }
  }
  return resolved;
}
