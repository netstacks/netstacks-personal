/**
 * Toggles or replaces a device selection.
 *
 * @param current - Current set of selected device IDs
 * @param id - Device ID to toggle or select
 * @param additive - If true, toggles id (add if absent, remove if present). If false, replaces entire selection with just id.
 * @returns New Set with updated selection
 */
export function toggleSelection(
  current: Set<string>,
  id: string,
  additive: boolean
): Set<string> {
  if (!additive) {
    return new Set([id]);
  }

  const next = new Set(current);
  if (next.has(id)) {
    next.delete(id);
  } else {
    next.add(id);
  }
  return next;
}

/**
 * Checks if a point is inside a box.
 *
 * @param pt - Point with x and y coordinates
 * @param box - Box with x1, y1, x2, y2 corners (normalized internally)
 * @returns True if point is inside or on the boundary of the box (inclusive)
 */
export function isInsideBox(
  pt: { x: number; y: number },
  box: { x1: number; y1: number; x2: number; y2: number }
): boolean {
  const xMin = Math.min(box.x1, box.x2);
  const xMax = Math.max(box.x1, box.x2);
  const yMin = Math.min(box.y1, box.y2);
  const yMax = Math.max(box.y1, box.y2);

  return pt.x >= xMin && pt.x <= xMax && pt.y >= yMin && pt.y <= yMax;
}

/**
 * Selects devices inside a box.
 *
 * @param devices - Array of devices with id, x, y
 * @param box - Selection box with x1, y1, x2, y2
 * @param base - Base selection set
 * @param additive - If true, unions result with base. If false, returns only devices inside box.
 * @returns New Set of selected device IDs
 */
export function selectInBox(
  devices: { id: string; x: number; y: number }[],
  box: { x1: number; y1: number; x2: number; y2: number },
  base: Set<string>,
  additive: boolean
): Set<string> {
  const enclosed = devices
    .filter((d) => isInsideBox({ x: d.x, y: d.y }, box))
    .map((d) => d.id);

  if (!additive) {
    return new Set(enclosed);
  }

  return new Set([...base, ...enclosed]);
}

/**
 * Applies a delta to a group of device positions.
 *
 * @param starts - Map of device IDs to starting positions
 * @param dx - X delta to apply
 * @param dy - Y delta to apply
 * @param clampMin - Minimum coordinate value (default 0)
 * @param clampMax - Maximum coordinate value (default 1000)
 * @returns New Map with updated positions, clamped to bounds
 */
export function applyGroupDelta(
  starts: Map<string, { x: number; y: number }>,
  dx: number,
  dy: number,
  clampMin = 0,
  clampMax = 1000
): Map<string, { x: number; y: number }> {
  const result = new Map<string, { x: number; y: number }>();

  for (const [id, pos] of starts) {
    const newX = Math.max(clampMin, Math.min(clampMax, pos.x + dx));
    const newY = Math.max(clampMin, Math.min(clampMax, pos.y + dy));
    result.set(id, { x: newX, y: newY });
  }

  return result;
}
