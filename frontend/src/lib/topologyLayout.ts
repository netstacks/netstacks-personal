/**
 * topologyLayout — pure, view-agnostic auto-layout for network topologies.
 *
 * Every algorithm takes the current devices + connections and returns new
 * positions in the shared 0–1000 coordinate space (see Device.x/Device.y).
 * The same result drives both the 2D canvas and the 3D X/Z-plane renderer.
 * Manual drags after a layout override these positions.
 */
import type { Device, Connection } from '../types/topology'

/** Available auto-layout formats. */
export type LayoutType = 'grid' | 'circular' | 'hierarchical' | 'forceDirected'

/** Position map keyed by device id. */
type PositionMap = Map<string, { x: number; y: number }>

/** Keep nodes off the extreme edge of the 0–1000 box. */
const MARGIN = 40
const MIN = MARGIN
const MAX = 1000 - MARGIN
const SPAN = MAX - MIN
const CENTER = 500

function clamp(v: number): number {
  if (Number.isNaN(v)) return CENTER
  return Math.min(MAX, Math.max(MIN, v))
}

/** Even grid of ⌈√n⌉ columns across the usable box. */
function layoutGrid(devices: Device[]): PositionMap {
  const pos: PositionMap = new Map()
  const n = devices.length
  if (n === 0) return pos
  const cols = Math.ceil(Math.sqrt(n))
  const rows = Math.ceil(n / cols)
  // Stable order for determinism.
  const ordered = [...devices].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
  const stepX = cols > 1 ? SPAN / (cols - 1) : 0
  const stepY = rows > 1 ? SPAN / (rows - 1) : 0
  ordered.forEach((d, i) => {
    const col = i % cols
    const row = Math.floor(i / cols)
    const x = cols > 1 ? MIN + col * stepX : CENTER
    const y = rows > 1 ? MIN + row * stepY : CENTER
    pos.set(d.id, { x: clamp(x), y: clamp(y) })
  })
  return pos
}

/** Evenly spaced ring centered at (500,500). */
function layoutCircular(devices: Device[]): PositionMap {
  const pos: PositionMap = new Map()
  const n = devices.length
  if (n === 0) return pos
  const ordered = [...devices].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
  if (n === 1) {
    pos.set(ordered[0].id, { x: CENTER, y: CENTER })
    return pos
  }
  const radius = SPAN / 2
  ordered.forEach((d, i) => {
    const angle = (2 * Math.PI * i) / n
    pos.set(d.id, {
      x: clamp(CENTER + radius * Math.cos(angle)),
      y: clamp(CENTER + radius * Math.sin(angle)),
    })
  })
  return pos
}

/** Device-type hierarchy rank: lower = higher in the topology (chosen as root first). */
const TYPE_RANK: Record<string, number> = {
  firewall: 0,
  router: 1,
  'load-balancer': 2,
  'wan-optimizer': 2,
  'sd-wan': 2,
  switch: 3,
  'wireless-controller': 3,
  'voice-gateway': 3,
  'access-point': 4,
  server: 5,
  storage: 5,
  virtual: 5,
  cloud: 5,
  iot: 6,
  unknown: 7,
}

/** Rank of a device's type (0 = firewall … 7 = unknown). */
function typeRank(d: Device): number {
  return TYPE_RANK[d.type] ?? 7
}

/**
 * Layered top-down tree. Roots chosen by type rank, then highest degree,
 * then lowest id. BFS assigns each device a depth (layer); layers become
 * rows (y by depth), nodes spread evenly along x within a layer.
 * Each connected component is laid out from its own root; an isolated node becomes its own depth-0 root.
 */
function layoutHierarchical(devices: Device[], connections: Connection[]): PositionMap {
  const pos: PositionMap = new Map()
  const n = devices.length
  if (n === 0) return pos

  const ids = new Set(devices.map(d => d.id))
  const adj = new Map<string, string[]>()
  for (const d of devices) adj.set(d.id, [])
  for (const c of connections) {
    if (ids.has(c.sourceDeviceId) && ids.has(c.targetDeviceId)) {
      adj.get(c.sourceDeviceId)!.push(c.targetDeviceId)
      adj.get(c.targetDeviceId)!.push(c.sourceDeviceId)
    }
  }

  const degree = (id: string) => adj.get(id)!.length

  // Deterministic root ordering: type rank, then higher degree, then id.
  const rootOrder = [...devices].sort((a, b) =>
    typeRank(a) - typeRank(b) ||
    degree(b.id) - degree(a.id) ||
    a.id.localeCompare(b.id),
  )

  // BFS over components, assigning depth.
  const depth = new Map<string, number>()
  const queue: string[] = []
  for (const root of rootOrder) {
    if (depth.has(root.id)) continue
    depth.set(root.id, 0)
    queue.push(root.id)
    while (queue.length > 0) {
      const cur = queue.shift()!
      const d = depth.get(cur)!
      const neighbors = [...adj.get(cur)!].sort((x, y) => x.localeCompare(y))
      for (const nb of neighbors) {
        if (!depth.has(nb)) {
          depth.set(nb, d + 1)
          queue.push(nb)
        }
      }
    }
  }

  // Group ids by layer.
  const layers = new Map<number, string[]>()
  let maxDepth = 0
  for (const d of devices) {
    const dp = depth.get(d.id) ?? 0
    maxDepth = Math.max(maxDepth, dp)
    const arr = layers.get(dp)
    if (arr) arr.push(d.id)
    else layers.set(dp, [d.id])
  }

  const stepY = maxDepth > 0 ? SPAN / maxDepth : 0
  for (const [dp, layerIds] of layers) {
    const ordered = [...layerIds].sort((a, b) => a.localeCompare(b))
    const count = ordered.length
    const stepX = count > 1 ? SPAN / (count - 1) : 0
    const y = maxDepth > 0 ? MIN + dp * stepY : CENTER
    ordered.forEach((id, i) => {
      const x = count > 1 ? MIN + i * stepX : CENTER
      pos.set(id, { x: clamp(x), y: clamp(y) })
    })
  }
  return pos
}

/**
 * Fruchterman–Reingold force-directed layout. Deterministic: seeded from the
 * devices' current positions (nudged apart when coincident, using index — not
 * randomness — so results are reproducible). Runs a fixed number of iterations
 * with linear cooling, then normalizes the settled coordinates into the box.
 */
function layoutForceDirected(devices: Device[], connections: Connection[]): PositionMap {
  const pos: PositionMap = new Map()
  const n = devices.length
  if (n === 0) return pos
  if (n === 1) {
    pos.set(devices[0].id, { x: CENTER, y: CENTER })
    return pos
  }

  const ids = new Set(devices.map(d => d.id))
  // Working coordinates, seeded from current positions. Nudge by index with unique
  // deterministic offsets so no two devices share identical coordinates.
  const p = new Map<string, { x: number; y: number }>()
  devices.forEach((d, i) => {
    p.set(d.id, {
      x: (d.x || CENTER) + i * 0.13,
      y: (d.y || CENTER) + i * 0.07,
    })
  })

  const edges = connections.filter(c => ids.has(c.sourceDeviceId) && ids.has(c.targetDeviceId))

  const area = SPAN * SPAN
  const k = Math.sqrt(area / n) // ideal edge length
  const iterations = 300
  let temp = SPAN * 0.1

  for (let iter = 0; iter < iterations; iter++) {
    const disp = new Map<string, { x: number; y: number }>()
    for (const d of devices) disp.set(d.id, { x: 0, y: 0 })

    // Repulsion between every pair.
    for (let i = 0; i < devices.length; i++) {
      for (let j = i + 1; j < devices.length; j++) {
        const a = p.get(devices[i].id)!
        const b = p.get(devices[j].id)!
        let dx = a.x - b.x
        let dy = a.y - b.y
        let dist = Math.hypot(dx, dy)
        if (dist < 0.01) { dx = 0.01; dy = 0.01; dist = 0.0141 }
        const force = (k * k) / dist
        const ux = (dx / dist) * force
        const uy = (dy / dist) * force
        const da = disp.get(devices[i].id)!
        const db = disp.get(devices[j].id)!
        da.x += ux; da.y += uy
        db.x -= ux; db.y -= uy
      }
    }

    // Attraction along edges.
    for (const e of edges) {
      const a = p.get(e.sourceDeviceId)!
      const b = p.get(e.targetDeviceId)!
      let dx = a.x - b.x
      let dy = a.y - b.y
      let dist = Math.hypot(dx, dy)
      if (dist < 0.01) { dx = 0.01; dy = 0.01; dist = 0.0141 }
      const force = (dist * dist) / k
      const ux = (dx / dist) * force
      const uy = (dy / dist) * force
      const da = disp.get(e.sourceDeviceId)!
      const db = disp.get(e.targetDeviceId)!
      da.x -= ux; da.y -= uy
      db.x += ux; db.y += uy
    }

    // Apply displacement, capped by temperature.
    for (const d of devices) {
      const dd = disp.get(d.id)!
      const cur = p.get(d.id)!
      const dist = Math.hypot(dd.x, dd.y)
      if (dist > 0.01) {
        cur.x += (dd.x / dist) * Math.min(dist, temp)
        cur.y += (dd.y / dist) * Math.min(dist, temp)
      }
    }
    temp = Math.max(temp - (SPAN * 0.1) / iterations, 0.1)
  }

  // Normalize settled coordinates into the [MIN, MAX] box.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const { x, y } of p.values()) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x)
    minY = Math.min(minY, y); maxY = Math.max(maxY, y)
  }
  const rangeX = maxX - minX
  const rangeY = maxY - minY
  for (const d of devices) {
    const cur = p.get(d.id)!
    pos.set(d.id, {
      x: clamp(MIN + (rangeX > 0 ? ((cur.x - minX) / rangeX) * SPAN : SPAN / 2)),
      y: clamp(MIN + (rangeY > 0 ? ((cur.y - minY) / rangeY) * SPAN : SPAN / 2)),
    })
  }
  return pos
}

/**
 * Compute new positions for every device using the chosen layout.
 * Does not mutate its inputs.
 */
export function computeLayout(
  type: LayoutType,
  devices: Device[],
  connections: Connection[],
): PositionMap {
  switch (type) {
    case 'grid':
      return layoutGrid(devices)
    case 'circular':
      return layoutCircular(devices)
    case 'hierarchical':
      return layoutHierarchical(devices, connections)
    case 'forceDirected':
      return layoutForceDirected(devices, connections)
    default:
      return layoutGrid(devices)
  }
}
