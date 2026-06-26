// Device icon drawing functions for topology canvas
// Clean stencil-style icons matching the device detail tab aesthetic.
// Each icon draws centered at (x, y) with specified size.

import type { Device, DeviceType, DeviceStatus } from '../types/topology';

/** Status color mapping */
const STATUS_COLORS: Record<DeviceStatus, string> = {
  online: '#4caf50',
  offline: '#f44336',
  warning: '#ff9800',
  unknown: '#9e9e9e',
};

/** Device type accent colors */
const TYPE_COLORS: Record<DeviceType, string> = {
  router: '#2196f3',
  switch: '#4caf50',
  firewall: '#f44336',
  server: '#9e9e9e',
  cloud: '#90caf9',
  'access-point': '#00bcd4',
  'load-balancer': '#00bcd4',
  'wan-optimizer': '#9c27b0',
  'voice-gateway': '#607d8b',
  'wireless-controller': '#3f51b5',
  storage: '#795548',
  virtual: '#009688',
  'sd-wan': '#8bc34a',
  iot: '#ff5722',
  unknown: '#607d8b',
};

/**
 * Get stroke color based on device status
 */
function getStatusColor(status: DeviceStatus): string {
  return STATUS_COLORS[status] || STATUS_COLORS.unknown;
}

/**
 * Helper: draw a rounded rectangle path (does not stroke or fill)
 */
function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

/**
 * Draw a router icon - rectangular chassis with port indicators (no antennas)
 */
export function drawRouter(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  status: DeviceStatus,
  isHovered = false,
  isSelected = false
): void {
  const color = getStatusColor(status);
  const w = size * 0.8;
  const h = size * 0.5;
  const r = 4;

  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = isHovered ? 2.5 : 1.5;

  // Chassis body
  roundRect(ctx, x - w / 2, y - h / 2, w, h, r);
  ctx.stroke();

  // Two indicator LEDs (filled circles) on left
  const ledR = size * 0.05;
  const ledY = y;
  ctx.beginPath();
  ctx.arc(x - w * 0.25, ledY, ledR, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x - w * 0.1, ledY, ledR, 0, Math.PI * 2);
  ctx.fill();

  // Two vertical port bars on right
  const barW = size * 0.04;
  const barH = h * 0.5;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(x + w * 0.1 - barW / 2, y - barH / 2, barW, barH);
  ctx.strokeRect(x + w * 0.25 - barW / 2, y - barH / 2, barW, barH);

  if (isSelected) drawSelectionRing(ctx, x, y, size);
}

/**
 * Draw a switch icon - flat wide chassis with port dots
 */
export function drawSwitch(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  status: DeviceStatus,
  isHovered = false,
  isSelected = false
): void {
  const color = getStatusColor(status);
  const w = size * 0.9;
  const h = size * 0.35;
  const r = 2;

  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = isHovered ? 2.5 : 1.5;

  // Chassis body
  roundRect(ctx, x - w / 2, y - h / 2, w, h, r);
  ctx.stroke();

  // Five port indicator dots across the middle
  const dotR = size * 0.04;
  const spacing = w / 6;
  const startX = x - w / 2 + spacing;
  for (let i = 0; i < 5; i++) {
    ctx.beginPath();
    ctx.arc(startX + i * spacing, y, dotR, 0, Math.PI * 2);
    ctx.fill();
  }

  if (isSelected) drawSelectionRing(ctx, x, y, size);
}

/**
 * Draw a firewall icon - square with grid pattern
 */
export function drawFirewall(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  status: DeviceStatus,
  isHovered = false,
  isSelected = false
): void {
  const color = getStatusColor(status);
  const s = size * 0.7;
  const r = 4;

  ctx.strokeStyle = color;
  ctx.lineWidth = isHovered ? 2.5 : 1.5;

  // Square body
  roundRect(ctx, x - s / 2, y - s / 2, s, s, r);
  ctx.stroke();

  // Grid lines (2 horizontal, 2 vertical)
  const third = s / 3;
  const left = x - s / 2;
  const top = y - s / 2;
  ctx.beginPath();
  ctx.moveTo(left, top + third);
  ctx.lineTo(left + s, top + third);
  ctx.moveTo(left, top + third * 2);
  ctx.lineTo(left + s, top + third * 2);
  ctx.moveTo(left + third, top);
  ctx.lineTo(left + third, top + s);
  ctx.moveTo(left + third * 2, top);
  ctx.lineTo(left + third * 2, top + s);
  ctx.stroke();

  if (isSelected) drawSelectionRing(ctx, x, y, size);
}

/**
 * Draw a server icon - three stacked rack units with LEDs
 */
export function drawServer(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  status: DeviceStatus,
  isHovered = false,
  isSelected = false
): void {
  const color = getStatusColor(status);
  const w = size * 0.65;
  const unitH = size * 0.22;
  const gap = size * 0.03;
  const totalH = unitH * 3 + gap * 2;
  const r = 2;

  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = isHovered ? 2.5 : 1.5;

  // Three stacked units
  for (let i = 0; i < 3; i++) {
    const uy = y - totalH / 2 + i * (unitH + gap);
    roundRect(ctx, x - w / 2, uy, w, unitH, r);
    ctx.stroke();

    // LED dot on left of each unit
    ctx.beginPath();
    ctx.arc(x - w / 2 + w * 0.15, uy + unitH / 2, size * 0.04, 0, Math.PI * 2);
    ctx.fill();
  }

  if (isSelected) drawSelectionRing(ctx, x, y, size);
}

/**
 * Draw a cloud icon
 */
export function drawCloud(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  status: DeviceStatus,
  isHovered = false,
  isSelected = false
): void {
  const color = getStatusColor(status);
  const s = size / 40;

  ctx.strokeStyle = color;
  ctx.lineWidth = isHovered ? 2.5 : 1.5;

  ctx.beginPath();
  ctx.arc(x, y + 4 * s, 14 * s, Math.PI * 0.2, Math.PI * 0.8, true);
  ctx.arc(x - 9 * s, y - 2 * s, 9 * s, Math.PI * 0.7, Math.PI * 1.5, false);
  ctx.arc(x - 3 * s, y - 10 * s, 7 * s, Math.PI * 1.2, Math.PI * 1.8, false);
  ctx.arc(x + 5 * s, y - 11 * s, 8 * s, Math.PI * 1.0, Math.PI * 1.9, false);
  ctx.arc(x + 11 * s, y - 4 * s, 7 * s, Math.PI * 1.4, Math.PI * 0.3, false);
  ctx.arc(x + 9 * s, y + 4 * s, 7 * s, Math.PI * 1.7, Math.PI * 0.2, false);
  ctx.closePath();
  ctx.stroke();

  if (isSelected) drawSelectionRing(ctx, x, y, size);
}

/**
 * Draw an access point icon - signal waves emanating from a point
 */
export function drawAccessPoint(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  status: DeviceStatus,
  isHovered = false,
  isSelected = false
): void {
  const color = getStatusColor(status);
  const hs = size / 2;

  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = isHovered ? 2.5 : 1.5;

  // Base dot
  ctx.beginPath();
  ctx.arc(x, y + hs * 0.3, 3, 0, Math.PI * 2);
  ctx.fill();

  // Three signal wave arcs
  for (let i = 1; i <= 3; i++) {
    const r = hs * 0.25 * i;
    ctx.beginPath();
    ctx.arc(x, y + hs * 0.3, r, Math.PI * 1.15, Math.PI * 1.85, false);
    ctx.stroke();
  }

  if (isSelected) drawSelectionRing(ctx, x, y, size);
}

/**
 * Draw a load balancer icon - horizontal bar with distribution lines
 */
export function drawLoadBalancer(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  status: DeviceStatus,
  isHovered = false,
  isSelected = false
): void {
  const color = getStatusColor(status);
  const hs = size / 2;

  ctx.strokeStyle = color;
  ctx.lineWidth = isHovered ? 2.5 : 1.5;

  // Central bar
  const barW = size * 0.7;
  const barH = size * 0.18;
  roundRect(ctx, x - barW / 2, y - barH / 2, barW, barH, 2);
  ctx.stroke();

  // Three lines going up, three going down
  const spacing = barW / 4;
  for (let i = -1; i <= 1; i++) {
    const lx = x + i * spacing;
    ctx.beginPath();
    ctx.moveTo(lx, y - barH / 2);
    ctx.lineTo(lx, y - hs * 0.7);
    ctx.moveTo(lx, y + barH / 2);
    ctx.lineTo(lx, y + hs * 0.7);
    ctx.stroke();
  }

  if (isSelected) drawSelectionRing(ctx, x, y, size);
}

/**
 * Draw a WAN optimizer icon - circle with gauge needle
 */
export function drawWanOptimizer(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  status: DeviceStatus,
  isHovered = false,
  isSelected = false
): void {
  const color = getStatusColor(status);
  const r = size * 0.38;

  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = isHovered ? 2.5 : 1.5;

  // Outer circle
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.stroke();

  // Gauge arc
  ctx.beginPath();
  ctx.arc(x, y + r * 0.1, r * 0.6, Math.PI * 0.85, Math.PI * 0.15, false);
  ctx.stroke();

  // Needle
  ctx.beginPath();
  ctx.moveTo(x, y + r * 0.1);
  ctx.lineTo(x + r * 0.45, y - r * 0.25);
  ctx.stroke();

  // Center dot
  ctx.beginPath();
  ctx.arc(x, y + r * 0.1, 2.5, 0, Math.PI * 2);
  ctx.fill();

  if (isSelected) drawSelectionRing(ctx, x, y, size);
}

/**
 * Draw a voice gateway icon - phone handset shape
 */
export function drawVoiceGateway(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  status: DeviceStatus,
  isHovered = false,
  isSelected = false
): void {
  const color = getStatusColor(status);
  const hs = size / 2;

  ctx.strokeStyle = color;
  ctx.lineWidth = isHovered ? 2.5 : 1.5;

  // Simplified handset using arcs
  ctx.beginPath();
  ctx.arc(x - hs * 0.3, y - hs * 0.4, hs * 0.22, Math.PI, 0, false);
  ctx.quadraticCurveTo(x + hs * 0.05, y - hs * 0.15, x + hs * 0.05, y);
  ctx.quadraticCurveTo(x + hs * 0.05, y + hs * 0.15, x - hs * 0.3, y + hs * 0.4);
  ctx.arc(x - hs * 0.3, y + hs * 0.4, hs * 0.22, 0, Math.PI, false);
  ctx.quadraticCurveTo(x - hs * 0.55, y + hs * 0.15, x - hs * 0.55, y);
  ctx.quadraticCurveTo(x - hs * 0.55, y - hs * 0.15, x - hs * 0.3 - hs * 0.22, y - hs * 0.4);
  ctx.stroke();

  // Sound waves
  ctx.lineWidth = 1.5;
  for (let i = 1; i <= 2; i++) {
    ctx.beginPath();
    ctx.arc(x + hs * 0.3, y - hs * 0.15, hs * 0.12 * i, -Math.PI / 4, Math.PI / 4, false);
    ctx.stroke();
  }

  if (isSelected) drawSelectionRing(ctx, x, y, size);
}

/**
 * Draw a wireless controller icon - rack box with antenna and waves
 */
export function drawWirelessController(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  status: DeviceStatus,
  isHovered = false,
  isSelected = false
): void {
  const color = getStatusColor(status);
  const hs = size / 2;

  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = isHovered ? 2.5 : 1.5;

  // Base box
  const bw = size * 0.65;
  const bh = size * 0.25;
  roundRect(ctx, x - bw / 2, y + hs * 0.1, bw, bh, 2);
  ctx.stroke();

  // LED on box
  ctx.beginPath();
  ctx.arc(x - bw * 0.3, y + hs * 0.1 + bh / 2, size * 0.04, 0, Math.PI * 2);
  ctx.fill();

  // Antenna mast
  ctx.beginPath();
  ctx.moveTo(x, y + hs * 0.1);
  ctx.lineTo(x, y - hs * 0.5);
  ctx.stroke();

  // Antenna waves
  ctx.lineWidth = 1.5;
  for (let i = 1; i <= 2; i++) {
    ctx.beginPath();
    ctx.arc(x, y - hs * 0.35, hs * 0.15 * i, Math.PI * 1.15, Math.PI * 1.85, false);
    ctx.stroke();
  }

  if (isSelected) drawSelectionRing(ctx, x, y, size);
}

/**
 * Draw a storage icon - database cylinder
 */
export function drawStorage(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  status: DeviceStatus,
  isHovered = false,
  isSelected = false
): void {
  const color = getStatusColor(status);
  const rw = size * 0.35;
  const rh = size * 0.12;
  const h = size * 0.5;

  ctx.strokeStyle = color;
  ctx.lineWidth = isHovered ? 2.5 : 1.5;

  // Top ellipse
  ctx.beginPath();
  ctx.ellipse(x, y - h / 2, rw, rh, 0, 0, Math.PI * 2);
  ctx.stroke();

  // Sides
  ctx.beginPath();
  ctx.moveTo(x - rw, y - h / 2);
  ctx.lineTo(x - rw, y + h / 2);
  ctx.moveTo(x + rw, y - h / 2);
  ctx.lineTo(x + rw, y + h / 2);
  ctx.stroke();

  // Bottom ellipse
  ctx.beginPath();
  ctx.ellipse(x, y + h / 2, rw, rh, 0, 0, Math.PI * 2);
  ctx.stroke();

  // Middle ring
  ctx.beginPath();
  ctx.ellipse(x, y, rw, rh, 0, Math.PI, Math.PI * 2);
  ctx.stroke();

  if (isSelected) drawSelectionRing(ctx, x, y, size);
}

/**
 * Draw a virtual device icon - overlapping squares
 */
export function drawVirtual(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  status: DeviceStatus,
  isHovered = false,
  isSelected = false
): void {
  const color = getStatusColor(status);
  const s = size * 0.35;
  const offset = size * 0.08;

  ctx.strokeStyle = color;
  ctx.lineWidth = isHovered ? 2.5 : 1.5;

  // Back box
  roundRect(ctx, x - s / 2 - offset, y - s / 2 - offset, s, s, 2);
  ctx.stroke();

  // Front box
  roundRect(ctx, x - s / 2 + offset, y - s / 2 + offset, s, s, 2);
  ctx.stroke();

  if (isSelected) drawSelectionRing(ctx, x, y, size);
}

/**
 * Draw an SD-WAN icon - cloud with connection lines below
 */
export function drawSdWan(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  status: DeviceStatus,
  isHovered = false,
  isSelected = false
): void {
  const color = getStatusColor(status);
  const s = size / 40;

  ctx.strokeStyle = color;
  ctx.lineWidth = isHovered ? 2.5 : 1.5;

  // Small cloud at top
  ctx.beginPath();
  ctx.arc(x, y - 4 * s, 9 * s, Math.PI * 0.3, Math.PI * 0.7, true);
  ctx.arc(x - 6 * s, y - 7 * s, 5 * s, Math.PI * 0.7, Math.PI * 1.4, false);
  ctx.arc(x - 2 * s, y - 12 * s, 4 * s, Math.PI * 1.2, Math.PI * 1.8, false);
  ctx.arc(x + 4 * s, y - 12 * s, 5 * s, Math.PI * 1.1, Math.PI * 1.9, false);
  ctx.arc(x + 8 * s, y - 7 * s, 4 * s, Math.PI * 1.5, Math.PI * 0.3, false);
  ctx.closePath();
  ctx.stroke();

  // Horizontal lines inside cloud
  ctx.beginPath();
  ctx.moveTo(x - 6 * s, y - 7 * s);
  ctx.lineTo(x + 6 * s, y - 7 * s);
  ctx.moveTo(x - 3 * s, y - 4 * s);
  ctx.lineTo(x + 3 * s, y - 4 * s);
  ctx.stroke();

  // Connection lines below
  ctx.beginPath();
  ctx.moveTo(x - 5 * s, y - 1 * s);
  ctx.lineTo(x - 8 * s, y + 10 * s);
  ctx.moveTo(x, y - 1 * s);
  ctx.lineTo(x, y + 10 * s);
  ctx.moveTo(x + 5 * s, y - 1 * s);
  ctx.lineTo(x + 8 * s, y + 10 * s);
  ctx.stroke();

  // Endpoint dots
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x - 8 * s, y + 11 * s, 2.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x, y + 11 * s, 2.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x + 8 * s, y + 11 * s, 2.5, 0, Math.PI * 2);
  ctx.fill();

  if (isSelected) drawSelectionRing(ctx, x, y, size);
}

/**
 * Draw an IoT icon - chip with connection pins
 */
export function drawIot(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  status: DeviceStatus,
  isHovered = false,
  isSelected = false
): void {
  const color = getStatusColor(status);
  const cs = size * 0.3;
  const pinLen = size * 0.15;

  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = isHovered ? 2.5 : 1.5;

  // Chip body
  roundRect(ctx, x - cs, y - cs, cs * 2, cs * 2, 4);
  ctx.stroke();

  // Corner dots inside chip
  const dotOff = cs * 0.5;
  const dotR = size * 0.04;
  ctx.beginPath();
  ctx.arc(x - dotOff, y - dotOff, dotR, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x + dotOff, y - dotOff, dotR, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x - dotOff, y + dotOff, dotR, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x + dotOff, y + dotOff, dotR, 0, Math.PI * 2);
  ctx.fill();

  // Pins on 4 sides (2 per side)
  ctx.lineWidth = 1.5;
  const pinOff = cs * 0.45;
  ctx.beginPath();
  // Top
  ctx.moveTo(x - pinOff, y - cs); ctx.lineTo(x - pinOff, y - cs - pinLen);
  ctx.moveTo(x + pinOff, y - cs); ctx.lineTo(x + pinOff, y - cs - pinLen);
  // Bottom
  ctx.moveTo(x - pinOff, y + cs); ctx.lineTo(x - pinOff, y + cs + pinLen);
  ctx.moveTo(x + pinOff, y + cs); ctx.lineTo(x + pinOff, y + cs + pinLen);
  // Left
  ctx.moveTo(x - cs, y - pinOff); ctx.lineTo(x - cs - pinLen, y - pinOff);
  ctx.moveTo(x - cs, y + pinOff); ctx.lineTo(x - cs - pinLen, y + pinOff);
  // Right
  ctx.moveTo(x + cs, y - pinOff); ctx.lineTo(x + cs + pinLen, y - pinOff);
  ctx.moveTo(x + cs, y + pinOff); ctx.lineTo(x + cs + pinLen, y + pinOff);
  ctx.stroke();

  if (isSelected) drawSelectionRing(ctx, x, y, size);
}

/**
 * Draw an unknown device icon - question mark in circle
 */
export function drawUnknown(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  status: DeviceStatus,
  isHovered = false,
  isSelected = false
): void {
  const color = getStatusColor(status);
  const r = size * 0.38;

  ctx.strokeStyle = color;
  ctx.lineWidth = isHovered ? 2.5 : 1.5;

  // Circle
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.stroke();

  // Question mark
  ctx.font = `${size * 0.4}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = color;
  ctx.fillText('?', x, y + 1);

  if (isSelected) drawSelectionRing(ctx, x, y, size);
}

/**
 * Draw a dashed selection ring around device
 */
function drawSelectionRing(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number
): void {
  const radius = size * 0.7;

  ctx.save();
  ctx.strokeStyle = '#007acc';
  ctx.lineWidth = 2;
  ctx.setLineDash([4, 4]);

  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.stroke();

  ctx.restore();
}

/**
 * Draw hover glow effect
 */
export function drawHoverGlow(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  status: DeviceStatus
): void {
  const color = getStatusColor(status);
  const radius = size * 0.6;

  ctx.save();
  ctx.shadowColor = color;
  ctx.shadowBlur = 15;
  ctx.strokeStyle = 'transparent';
  ctx.lineWidth = 1;

  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.stroke();

  ctx.restore();
}

/**
 * Main dispatcher - draws appropriate icon based on device type
 */
export function drawDevice(
  ctx: CanvasRenderingContext2D,
  device: Device,
  x: number,
  y: number,
  size: number,
  isHovered = false,
  isSelected = false
): void {
  // Draw hover glow effect if hovered
  if (isHovered) {
    drawHoverGlow(ctx, x, y, size, device.status);
  }

  // Neighbor visual distinction: dimmed opacity
  if (device.isNeighbor) {
    ctx.save();
    ctx.globalAlpha = 0.5;
  }

  // Dispatch to specific icon drawer based on type
  const drawFn = getDrawFunction(device.type);
  drawFn(ctx, x, y, size, device.status, isHovered, isSelected);

  // Neighbor overlay: dashed border and "N" badge
  if (device.isNeighbor) {
    // Dashed border around device
    const borderSize = size * 0.55;
    ctx.setLineDash([4, 3]);
    ctx.strokeStyle = '#888888';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x - borderSize, y - borderSize, borderSize * 2, borderSize * 2);
    ctx.setLineDash([]);

    // "N" badge in top-right corner
    const badgeX = x + size * 0.35;
    const badgeY = y - size * 0.35;
    const badgeR = 7;
    ctx.globalAlpha = 1.0; // Badge always full opacity
    ctx.beginPath();
    ctx.arc(badgeX, badgeY, badgeR, 0, Math.PI * 2);
    ctx.fillStyle = '#666666';
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 9px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('N', badgeX, badgeY);

    ctx.restore(); // Restore globalAlpha and other state
  }
}

/**
 * Get the appropriate draw function for a device type
 */
function getDrawFunction(
  type: DeviceType
): (
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  status: DeviceStatus,
  isHovered?: boolean,
  isSelected?: boolean
) => void {
  switch (type) {
    case 'router':
      return drawRouter;
    case 'switch':
      return drawSwitch;
    case 'firewall':
      return drawFirewall;
    case 'server':
      return drawServer;
    case 'cloud':
      return drawCloud;
    case 'access-point':
      return drawAccessPoint;
    case 'load-balancer':
      return drawLoadBalancer;
    case 'wan-optimizer':
      return drawWanOptimizer;
    case 'voice-gateway':
      return drawVoiceGateway;
    case 'wireless-controller':
      return drawWirelessController;
    case 'storage':
      return drawStorage;
    case 'virtual':
      return drawVirtual;
    case 'sd-wan':
      return drawSdWan;
    case 'iot':
      return drawIot;
    case 'unknown':
    default:
      return drawUnknown;
  }
}

// Re-export TYPE_COLORS for external use
export { TYPE_COLORS, STATUS_COLORS };
