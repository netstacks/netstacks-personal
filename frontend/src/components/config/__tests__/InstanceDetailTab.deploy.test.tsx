import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import type { ConfigStack, ConfigStackInstance } from '../../../api/configManagement';
import * as configApi from '../../../api/configManagement';
import InstanceDetailTab from '../InstanceDetailTab';

vi.mock('../../../api/configManagement', () => ({
  getStackInstance: vi.fn(),
  getConfigStack: vi.fn(),
  createStackInstance: vi.fn(),
  updateStackInstance: vi.fn(),
  deleteStackInstance: vi.fn(),
  deployStackInstance: vi.fn(async () => ({})),
  resolveStackVariables: vi.fn(),
  renderConfigStack: vi.fn(),
  listConfigDeployments: vi.fn(async () => []),
  getConfigDeploymentDetail: vi.fn(),
  getDeploymentLogs: vi.fn(),
  rollbackDeployment: vi.fn(),
  listConfigTemplates: vi.fn(async () => []),
}));

vi.mock('../../../api/enterpriseDevices', () => ({
  listEnterpriseDevices: vi.fn(async () => ({ items: [], total: 0 })),
}));

afterEach(() => cleanup());

const instance: ConfigStackInstance = {
  id: 'inst-1', org_id: 'org', stack_id: 'stack-1', name: 'edge-acl',
  target_devices: {}, variable_values: {}, device_overrides: {}, state: 'draft',
  created_by: 'u', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
};

function stack(requireMop: boolean): ConfigStack {
  return {
    id: 'stack-1', org_id: 'org', name: 'ACL stack', description: null, atomic: true, services: [],
    deployment_procedure: { pre_checks: [], post_checks: [], require_mop: requireMop },
    created_by: 'u', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
  };
}

async function openDeployDialog(requireMop: boolean) {
  vi.mocked(configApi.getStackInstance).mockResolvedValue(instance);
  vi.mocked(configApi.getConfigStack).mockResolvedValue(stack(requireMop));
  render(<InstanceDetailTab instanceId="inst-1" />);
  fireEvent.click(await screen.findByRole('button', { name: 'Deploy Now' }));
}

describe('InstanceDetailTab deploy dialog (deploy-with-mop removed)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('never offers "Deploy with Procedure" or a control-mode picker', async () => {
    await openDeployDialog(false);
    expect(screen.queryByText('Deploy with Procedure')).toBeNull();
    expect(screen.queryByLabelText('Control Mode')).toBeNull();
    expect(screen.getByRole('button', { name: 'Quick Deploy' })).toBeTruthy();
  });

  it('shows a MOP notice and no deploy button when the stack requires a MOP', async () => {
    await openDeployDialog(true);
    expect(screen.getByText('This stack requires a MOP — create one in MOPs.')).toBeTruthy();
    expect(screen.queryByText('Deploy with Procedure')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Quick Deploy' })).toBeNull();
    expect(configApi.deployStackInstance).not.toHaveBeenCalled();
  });
});
