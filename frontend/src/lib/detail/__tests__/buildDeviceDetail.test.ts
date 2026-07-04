import { describe, it, expect, beforeEach } from 'vitest';
import type { DetailSection, DeviceDetailProvider, DeviceDetailContext } from '../types';
import type { Device } from '../../../types/topology';
import { normalizeSections, registerDeviceDetailProvider, buildDeviceDetail } from '../buildDeviceDetail';

describe('normalizeSections', () => {
  it('drops fields with empty string values', () => {
    const sections: DetailSection[] = [
      {
        id: 'test',
        title: 'Test Section',
        priority: 10,
        fields: [
          { key: 'keep', label: 'Keep', value: 'data' },
          { key: 'drop', label: 'Drop', value: '' },
          { key: 'keep2', label: 'Keep2', value: 'more data' },
        ],
      },
    ];

    const result = normalizeSections(sections);
    expect(result[0].fields).toHaveLength(2);
    expect(result[0].fields[0].key).toBe('keep');
    expect(result[0].fields[1].key).toBe('keep2');
  });

  it('drops fields with N/A value (case-insensitive)', () => {
    const sections: DetailSection[] = [
      {
        id: 'test',
        title: 'Test Section',
        priority: 10,
        fields: [
          { key: 'keep', label: 'Keep', value: 'data' },
          { key: 'drop1', label: 'Drop1', value: 'N/A' },
          { key: 'drop2', label: 'Drop2', value: 'n/a' },
          { key: 'drop3', label: 'Drop3', value: 'N/a' },
        ],
      },
    ];

    const result = normalizeSections(sections);
    expect(result[0].fields).toHaveLength(1);
    expect(result[0].fields[0].key).toBe('keep');
  });

  it('drops fields with Unknown value (case-insensitive)', () => {
    const sections: DetailSection[] = [
      {
        id: 'test',
        title: 'Test Section',
        priority: 10,
        fields: [
          { key: 'keep', label: 'Keep', value: 'data' },
          { key: 'drop1', label: 'Drop1', value: 'Unknown' },
          { key: 'drop2', label: 'Drop2', value: 'unknown' },
          { key: 'drop3', label: 'Drop3', value: 'UNKNOWN' },
        ],
      },
    ];

    const result = normalizeSections(sections);
    expect(result[0].fields).toHaveLength(1);
    expect(result[0].fields[0].key).toBe('keep');
  });

  it('merges sections with the same id by concatenating fields in first-seen order', () => {
    const sections: DetailSection[] = [
      {
        id: 'test',
        title: 'Test Section',
        priority: 10,
        fields: [
          { key: 'field1', label: 'Field 1', value: 'value1' },
          { key: 'field2', label: 'Field 2', value: 'value2' },
        ],
      },
      {
        id: 'test',
        title: 'Test Section',
        priority: 10,
        fields: [
          { key: 'field3', label: 'Field 3', value: 'value3' },
        ],
      },
      {
        id: 'other',
        title: 'Other Section',
        priority: 20,
        fields: [
          { key: 'other1', label: 'Other 1', value: 'othervalue' },
        ],
      },
    ];

    const result = normalizeSections(sections);
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('test');
    expect(result[0].fields).toHaveLength(3);
    expect(result[0].fields[0].key).toBe('field1');
    expect(result[0].fields[1].key).toBe('field2');
    expect(result[0].fields[2].key).toBe('field3');
    expect(result[1].id).toBe('other');
  });

  it('drops sections left with no fields after filtering', () => {
    const sections: DetailSection[] = [
      {
        id: 'empty',
        title: 'Empty Section',
        priority: 10,
        fields: [
          { key: 'drop1', label: 'Drop1', value: '' },
          { key: 'drop2', label: 'Drop2', value: 'N/A' },
        ],
      },
      {
        id: 'keep',
        title: 'Keep Section',
        priority: 20,
        fields: [
          { key: 'field1', label: 'Field 1', value: 'data' },
        ],
      },
    ];

    const result = normalizeSections(sections);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('keep');
  });

  it('sorts sections by priority (stable sort, ascending)', () => {
    const sections: DetailSection[] = [
      {
        id: 'third',
        title: 'Third',
        priority: 30,
        fields: [{ key: 'f1', label: 'F1', value: 'v1' }],
      },
      {
        id: 'first',
        title: 'First',
        priority: 10,
        fields: [{ key: 'f2', label: 'F2', value: 'v2' }],
      },
      {
        id: 'second',
        title: 'Second',
        priority: 20,
        fields: [{ key: 'f3', label: 'F3', value: 'v3' }],
      },
    ];

    const result = normalizeSections(sections);
    expect(result).toHaveLength(3);
    expect(result[0].id).toBe('first');
    expect(result[1].id).toBe('second');
    expect(result[2].id).toBe('third');
  });
});

describe('registerDeviceDetailProvider and buildDeviceDetail', () => {
  // Reset providers between tests by re-importing
  beforeEach(() => {
    // Note: Since we can't easily reset module state, we rely on
    // test isolation. In a real scenario, we'd expose a reset function.
  });

  it('runs a registered provider and includes its sections in output', () => {
    const fakeProvider: DeviceDetailProvider = (device, ctx) => [
      {
        id: 'fake',
        title: 'Fake Section',
        priority: 100,
        fields: [
          { key: 'test', label: 'Test', value: 'fake data' },
        ],
      },
    ];

    registerDeviceDetailProvider(fakeProvider);

    const fakeDevice = {
      id: 'dev-1',
      name: 'Test Device',
      type: 'router',
      status: 'online',
      x: 100,
      y: 200,
    } as Device;

    const fakeContext: DeviceDetailContext = {
      isEnterprise: false,
      hasFeature: () => false,
    };

    const result = buildDeviceDetail(fakeDevice, fakeContext);

    // Should contain the fake provider's section
    const fakeSection = result.find(s => s.id === 'fake');
    expect(fakeSection).toBeDefined();
    expect(fakeSection?.fields).toHaveLength(1);
    expect(fakeSection?.fields[0].value).toBe('fake data');
  });

  it('normalizes output (drops empty fields, merges sections, sorts by priority)', () => {
    const provider1: DeviceDetailProvider = (device, ctx) => [
      {
        id: 'shared',
        title: 'Shared Section',
        priority: 10,
        fields: [
          { key: 'field1', label: 'Field 1', value: 'value1' },
          { key: 'empty', label: 'Empty', value: '' },
        ],
      },
    ];

    const provider2: DeviceDetailProvider = (device, ctx) => [
      {
        id: 'shared',
        title: 'Shared Section',
        priority: 10,
        fields: [
          { key: 'field2', label: 'Field 2', value: 'value2' },
        ],
      },
      {
        id: 'high-priority',
        title: 'High Priority',
        priority: 5,
        fields: [
          { key: 'hp', label: 'HP', value: 'high' },
        ],
      },
    ];

    registerDeviceDetailProvider(provider1);
    registerDeviceDetailProvider(provider2);

    const fakeDevice = { id: 'dev-1', name: 'Test' } as Device;
    const fakeContext: DeviceDetailContext = {
      isEnterprise: false,
      hasFeature: () => false,
    };

    const result = buildDeviceDetail(fakeDevice, fakeContext);

    // Should be sorted by priority (5, 10)
    expect(result[0].id).toBe('high-priority');
    expect(result[1].id).toBe('shared');

    // Shared section should have merged fields (empty dropped)
    const sharedSection = result.find(s => s.id === 'shared');
    expect(sharedSection?.fields).toHaveLength(2);
    expect(sharedSection?.fields[0].key).toBe('field1');
    expect(sharedSection?.fields[1].key).toBe('field2');
  });
});
