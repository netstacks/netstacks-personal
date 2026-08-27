import { describe, it, expect } from 'vitest';
import { csvToExportData, planSortOrder, SORT_ORDER_STEP } from './sessions';

const sib = (id: string, sort_order: number) => ({ id, sort_order });

describe('planSortOrder', () => {
  it('returns the step for an empty sibling list', () => {
    expect(planSortOrder([], 0, 'before')).toEqual({ sortOrder: SORT_ORDER_STEP, renumbered: [] });
  });

  it('appends after the max for inside drops', () => {
    const r = planSortOrder([sib('a', 0), sib('b', 5000)], 0, 'inside');
    expect(r).toEqual({ sortOrder: 6000, renumbered: [] });
  });

  it('uses an integer midpoint when there is room', () => {
    const r = planSortOrder([sib('a', 1000), sib('b', 2000)], 1, 'before');
    expect(r).toEqual({ sortOrder: 1500, renumbered: [] });
  });

  it('places before the first sibling below its order (not a tie at 0)', () => {
    const r = planSortOrder([sib('a', 0), sib('b', 1000)], 0, 'before');
    expect(r.sortOrder).toBeLessThan(0);
    expect(r.renumbered).toEqual([]);
  });

  it('renumbers when every sibling shares the same order', () => {
    const r = planSortOrder([sib('a', 0), sib('b', 0), sib('c', 0)], 0, 'after');
    expect(r.sortOrder).toBe(2000);
    expect(r.renumbered).toEqual([
      { id: 'a', sort_order: 1000 },
      { id: 'b', sort_order: 3000 },
      { id: 'c', sort_order: 4000 },
    ]);
  });

  it('renumbers when the neighbour gap has no integer between', () => {
    const r = planSortOrder([sib('a', 1000), sib('b', 1001)], 1, 'before');
    expect(r.renumbered.map(x => x.id)).toEqual(['a', 'b']);
    expect(r.sortOrder).toBe(2000);
    expect(r.renumbered[0].sort_order).toBeLessThan(r.sortOrder);
    expect(r.renumbered[1].sort_order).toBeGreaterThan(r.sortOrder);
  });

  it('ignores the moving item when computing neighbours', () => {
    // Drag 'c' to before 'a' in the same parent: its own slot must not count.
    const r = planSortOrder([sib('a', 1000), sib('b', 2000), sib('c', 3000)], 0, 'before', new Set(['c']));
    expect(r).toEqual({ sortOrder: 0, renumbered: [] });
  });
});

describe('csvToExportData', () => {
  it('emits port_forwards so the agent ExportSession deserializes', () => {
    const { data, warnings } = csvToExportData('name,host,port,folder,profile\nr1,10.0.0.1,22,Lab,default');
    expect(warnings).toEqual([]);
    expect(data.sessions).toHaveLength(1);
    expect(data.sessions[0].port_forwards).toEqual([]);
    expect(data.sessions[0].folder_name).toBe('Lab');
  });
});
