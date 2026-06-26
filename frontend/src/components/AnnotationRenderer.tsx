/**
 * AnnotationRenderer - Canvas rendering functions for topology annotations
 *
 * Provides drawing functions for text labels, shapes, and freeform lines
 * that overlay on the topology canvas for visual documentation.
 */

import type {
  Annotation,
  TextAnnotation,
  ShapeAnnotation,
  LineAnnotation,
  GroupAnnotation,
  StrokeStyle,
} from '../types/annotations';

/** Transform from world coordinates to screen coordinates */
export interface CanvasTransform {
  scale: number;
  offsetX: number;
  offsetY: number;
}

/** Selection handle size in pixels */
const HANDLE_SIZE = 8;
/** Selection outline padding */
const SELECTION_PADDING = 4;
/** Arrow head size */
const ARROW_SIZE = 10;

/**
 * Apply stroke style to canvas context
 */
function applyStrokeStyle(ctx: CanvasRenderingContext2D, style: StrokeStyle, width: number): void {
  ctx.lineWidth = width;
  switch (style) {
    case 'dashed':
      ctx.setLineDash([width * 4, width * 2]);
      break;
    case 'dotted':
      ctx.setLineDash([width, width * 2]);
      break;
    case 'solid':
    default:
      ctx.setLineDash([]);
      break;
  }
}

/**
 * Transform world coordinates to screen coordinates
 */
function worldToScreen(x: number, y: number, transform: CanvasTransform): { x: number; y: number } {
  return {
    x: x * transform.scale + transform.offsetX,
    y: y * transform.scale + transform.offsetY,
  };
}

/**
 * Get CSS font family string
 */
function getFontFamilyString(fontFamily?: string): string {
  switch (fontFamily) {
    case 'serif':
      return 'Georgia, "Times New Roman", serif';
    case 'monospace':
      return '"SF Mono", "Monaco", "Menlo", monospace';
    case 'sans-serif':
    default:
      return 'system-ui, -apple-system, sans-serif';
  }
}

/**
 * Render a text annotation
 */
function renderTextAnnotation(
  ctx: CanvasRenderingContext2D,
  annotation: TextAnnotation,
  transform: CanvasTransform,
  isSelected: boolean
): void {
  // Guard against missing position
  if (!annotation.position) {
    console.warn('[AnnotationRenderer] Text annotation missing position:', annotation.id);
    return;
  }
  const pos = worldToScreen(annotation.position.x, annotation.position.y, transform);
  const fontSize = annotation.fontSize * transform.scale;

  // Build font string with family, style, and weight
  const fontStyle = annotation.fontStyle === 'italic' ? 'italic ' : '';
  const fontWeight = annotation.fontWeight === 'bold' ? 'bold ' : '';
  const fontFamily = getFontFamilyString(annotation.fontFamily);
  ctx.font = `${fontStyle}${fontWeight}${fontSize}px ${fontFamily}`;

  // Set text alignment
  const textAlign = annotation.textAlign || 'left';
  ctx.textAlign = textAlign;
  ctx.textBaseline = 'top';

  // Apply opacity
  const savedAlpha = ctx.globalAlpha;
  ctx.globalAlpha = annotation.opacity ?? 1;

  // Measure text for background box
  const lines = (annotation.content || '').split('\n');
  const lineHeight = fontSize * 1.2;
  let maxWidth = 0;
  for (const line of lines) {
    const metrics = ctx.measureText(line);
    maxWidth = Math.max(maxWidth, metrics.width);
  }
  const textHeight = lines.length * lineHeight;
  const padding = 6 * transform.scale;

  // Calculate text X position based on alignment
  let textX = pos.x;
  if (textAlign === 'center') {
    textX = pos.x + maxWidth / 2;
  } else if (textAlign === 'right') {
    textX = pos.x + maxWidth;
  }

  // Draw background if specified
  if (annotation.backgroundColor) {
    ctx.fillStyle = annotation.backgroundColor;
    ctx.beginPath();
    ctx.roundRect(
      pos.x - padding,
      pos.y - padding,
      maxWidth + padding * 2,
      textHeight + padding * 2,
      4 * transform.scale
    );
    ctx.fill();
  }

  // Draw text
  ctx.fillStyle = annotation.color;
  for (let i = 0; i < lines.length; i++) {
    ctx.fillText(lines[i], textX, pos.y + i * lineHeight);
  }

  // Restore alpha
  ctx.globalAlpha = savedAlpha;

  // Draw selection handles if selected
  if (isSelected) {
    drawSelectionRect(ctx, pos.x - padding, pos.y - padding, maxWidth + padding * 2, textHeight + padding * 2);
    drawHandle(ctx, pos.x - padding, pos.y - padding); // top-left
    drawHandle(ctx, pos.x + maxWidth + padding, pos.y - padding); // top-right
    drawHandle(ctx, pos.x - padding, pos.y + textHeight + padding); // bottom-left
    drawHandle(ctx, pos.x + maxWidth + padding, pos.y + textHeight + padding); // bottom-right
  }
}

/**
 * Render a shape annotation
 */
function renderShapeAnnotation(
  ctx: CanvasRenderingContext2D,
  annotation: ShapeAnnotation,
  transform: CanvasTransform,
  isSelected: boolean
): void {
  // Guard against missing position or size
  if (!annotation.position || !annotation.size) {
    console.warn('[AnnotationRenderer] Shape annotation missing position or size:', annotation.id);
    return;
  }
  const pos = worldToScreen(annotation.position.x, annotation.position.y, transform);
  const width = annotation.size.width * transform.scale;
  const height = annotation.size.height * transform.scale;
  const strokeWidth = annotation.strokeWidth * transform.scale;
  const borderRadius = (annotation.borderRadius || 0) * transform.scale;

  // Apply stroke style
  applyStrokeStyle(ctx, annotation.strokeStyle, strokeWidth);
  ctx.strokeStyle = annotation.strokeColor;
  if (annotation.fillColor) {
    ctx.fillStyle = annotation.fillColor;
  }

  // Save the original alpha
  const savedAlpha = ctx.globalAlpha;

  ctx.beginPath();

  switch (annotation.shapeType) {
    case 'rectangle': {
      // Draw with border radius if specified
      if (borderRadius > 0) {
        ctx.beginPath();
        ctx.roundRect(pos.x, pos.y, width, height, borderRadius);
        if (annotation.fillColor) {
          ctx.globalAlpha = annotation.fillOpacity ?? 1;
          ctx.fill();
        }
        ctx.globalAlpha = annotation.strokeOpacity ?? 1;
        ctx.stroke();
      } else {
        if (annotation.fillColor) {
          ctx.globalAlpha = annotation.fillOpacity ?? 1;
          ctx.fillRect(pos.x, pos.y, width, height);
        }
        ctx.globalAlpha = annotation.strokeOpacity ?? 1;
        ctx.strokeRect(pos.x, pos.y, width, height);
      }
      ctx.globalAlpha = savedAlpha;
      break;
    }

    case 'circle': {
      const centerX = pos.x + width / 2;
      const centerY = pos.y + height / 2;
      const radiusX = width / 2;
      const radiusY = height / 2;
      ctx.ellipse(centerX, centerY, radiusX, radiusY, 0, 0, Math.PI * 2);
      if (annotation.fillColor) {
        ctx.globalAlpha = annotation.fillOpacity ?? 1;
        ctx.fill();
      }
      ctx.globalAlpha = annotation.strokeOpacity ?? 1;
      ctx.stroke();
      ctx.globalAlpha = savedAlpha;
      break;
    }

    case 'diamond': {
      const centerX = pos.x + width / 2;
      const centerY = pos.y + height / 2;
      ctx.moveTo(centerX, pos.y); // top
      ctx.lineTo(pos.x + width, centerY); // right
      ctx.lineTo(centerX, pos.y + height); // bottom
      ctx.lineTo(pos.x, centerY); // left
      ctx.closePath();
      if (annotation.fillColor) {
        ctx.globalAlpha = annotation.fillOpacity ?? 1;
        ctx.fill();
      }
      ctx.globalAlpha = annotation.strokeOpacity ?? 1;
      ctx.stroke();
      ctx.globalAlpha = savedAlpha;
      break;
    }

    case 'arrow': {
      // Arrow pointing right within bounding box
      const arrowHeadSize = Math.min(width * 0.3, height * 0.4);
      const shaftHeight = height * 0.4;
      const shaftTop = pos.y + (height - shaftHeight) / 2;
      const shaftBottom = shaftTop + shaftHeight;
      const arrowStart = pos.x + width - arrowHeadSize;

      ctx.moveTo(pos.x, shaftTop);
      ctx.lineTo(arrowStart, shaftTop);
      ctx.lineTo(arrowStart, pos.y);
      ctx.lineTo(pos.x + width, pos.y + height / 2);
      ctx.lineTo(arrowStart, pos.y + height);
      ctx.lineTo(arrowStart, shaftBottom);
      ctx.lineTo(pos.x, shaftBottom);
      ctx.closePath();
      if (annotation.fillColor) {
        ctx.globalAlpha = annotation.fillOpacity ?? 1;
        ctx.fill();
      }
      ctx.globalAlpha = annotation.strokeOpacity ?? 1;
      ctx.stroke();
      ctx.globalAlpha = savedAlpha;
      break;
    }

    case 'cloud': {
      // Draw cloud as overlapping circles/arcs
      const cx = pos.x + width / 2;
      const cy = pos.y + height / 2;
      const rx = width / 2;
      const ry = height / 2;

      // Create cloud path with bumpy edges
      ctx.beginPath();

      // Bottom arc
      ctx.ellipse(cx, cy + ry * 0.3, rx * 0.8, ry * 0.5, 0, 0.2, Math.PI - 0.2);

      // Left bumps
      ctx.ellipse(cx - rx * 0.5, cy - ry * 0.1, rx * 0.4, ry * 0.5, 0, Math.PI * 0.5, Math.PI * 1.5);

      // Top bumps
      ctx.ellipse(cx - rx * 0.2, cy - ry * 0.5, rx * 0.35, ry * 0.4, 0, Math.PI, 0);
      ctx.ellipse(cx + rx * 0.25, cy - ry * 0.45, rx * 0.4, ry * 0.45, 0, Math.PI, 0);

      // Right bumps
      ctx.ellipse(cx + rx * 0.55, cy - ry * 0.05, rx * 0.35, ry * 0.5, 0, -Math.PI * 0.5, Math.PI * 0.5);

      ctx.closePath();
      if (annotation.fillColor) {
        ctx.globalAlpha = annotation.fillOpacity ?? 1;
        ctx.fill();
      }
      ctx.globalAlpha = annotation.strokeOpacity ?? 1;
      ctx.stroke();
      ctx.globalAlpha = savedAlpha;
      break;
    }
  }

  // Reset line dash
  ctx.setLineDash([]);

  // Draw label inside shape if specified
  if (annotation.label) {
    const labelFontSize = (annotation.labelFontSize || 14) * transform.scale;
    const effectiveLabelSize = Math.min(labelFontSize, height * 0.4);
    ctx.font = `${effectiveLabelSize}px system-ui, -apple-system, sans-serif`;
    ctx.fillStyle = annotation.labelColor || annotation.strokeColor;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(annotation.label, pos.x + width / 2, pos.y + height / 2);
  }

  // Draw selection handles if selected
  if (isSelected) {
    drawSelectionRect(ctx, pos.x, pos.y, width, height);
    drawHandle(ctx, pos.x, pos.y); // top-left
    drawHandle(ctx, pos.x + width, pos.y); // top-right
    drawHandle(ctx, pos.x, pos.y + height); // bottom-left
    drawHandle(ctx, pos.x + width, pos.y + height); // bottom-right
    drawHandle(ctx, pos.x + width / 2, pos.y); // top-center
    drawHandle(ctx, pos.x + width / 2, pos.y + height); // bottom-center
    drawHandle(ctx, pos.x, pos.y + height / 2); // left-center
    drawHandle(ctx, pos.x + width, pos.y + height / 2); // right-center
  }
}

/**
 * Render a line annotation
 */
function renderLineAnnotation(
  ctx: CanvasRenderingContext2D,
  annotation: LineAnnotation,
  transform: CanvasTransform,
  isSelected: boolean
): void {
  if (annotation.points.length < 2) return;

  const screenPoints = annotation.points.map(p => worldToScreen(p.x, p.y, transform));
  const lineWidth = annotation.lineWidth * transform.scale;

  // Save and apply opacity
  const savedAlpha = ctx.globalAlpha;
  ctx.globalAlpha = annotation.opacity ?? 1;

  // Apply line style
  applyStrokeStyle(ctx, annotation.lineStyle, lineWidth);
  ctx.strokeStyle = annotation.color;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  ctx.beginPath();

  if (annotation.curveStyle === 'curved' && screenPoints.length > 2) {
    // Draw smooth curve through points using quadratic bezier
    ctx.moveTo(screenPoints[0].x, screenPoints[0].y);

    for (let i = 0; i < screenPoints.length - 1; i++) {
      const p0 = screenPoints[i];
      const p1 = screenPoints[i + 1];

      if (i === screenPoints.length - 2) {
        // Last segment - draw to final point
        ctx.lineTo(p1.x, p1.y);
      } else {
        // Midpoint for smooth curve
        const midX = (p0.x + p1.x) / 2;
        const midY = (p0.y + p1.y) / 2;
        ctx.quadraticCurveTo(p0.x, p0.y, midX, midY);
      }
    }
  } else {
    // Draw straight line segments
    ctx.moveTo(screenPoints[0].x, screenPoints[0].y);
    for (let i = 1; i < screenPoints.length; i++) {
      ctx.lineTo(screenPoints[i].x, screenPoints[i].y);
    }
  }

  ctx.stroke();
  ctx.setLineDash([]);

  // Draw arrow at start
  if (annotation.arrowStart && screenPoints.length >= 2) {
    const p0 = screenPoints[0];
    const p1 = screenPoints[1];
    drawArrowHead(ctx, p1.x, p1.y, p0.x, p0.y, annotation.color, lineWidth);
  }

  // Draw arrow at end
  if (annotation.arrowEnd && screenPoints.length >= 2) {
    const p0 = screenPoints[screenPoints.length - 2];
    const p1 = screenPoints[screenPoints.length - 1];
    drawArrowHead(ctx, p0.x, p0.y, p1.x, p1.y, annotation.color, lineWidth);
  }

  // Restore alpha
  ctx.globalAlpha = savedAlpha;

  // Draw selection handles if selected
  if (isSelected) {
    for (const point of screenPoints) {
      drawHandle(ctx, point.x, point.y);
    }
  }
}

/**
 * Render a group annotation (bounding box around grouped items)
 */
function renderGroupAnnotation(
  ctx: CanvasRenderingContext2D,
  annotation: GroupAnnotation,
  transform: CanvasTransform,
  isSelected: boolean,
  allAnnotations: Annotation[]
): void {
  // Find bounding box of all member annotations
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let hasMembers = false;

  for (const memberId of annotation.memberIds) {
    const member = allAnnotations.find(a => a.id === memberId);
    if (!member) continue;

    hasMembers = true;
    const bounds = getAnnotationBounds(member);
    minX = Math.min(minX, bounds.x);
    minY = Math.min(minY, bounds.y);
    maxX = Math.max(maxX, bounds.x + bounds.width);
    maxY = Math.max(maxY, bounds.y + bounds.height);
  }

  if (!hasMembers) return;

  // Transform to screen coordinates
  const topLeft = worldToScreen(minX, minY, transform);
  const bottomRight = worldToScreen(maxX, maxY, transform);
  const width = bottomRight.x - topLeft.x;
  const height = bottomRight.y - topLeft.y;
  const padding = 10 * transform.scale;

  // Draw dashed bounding box
  ctx.strokeStyle = '#666';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.strokeRect(
    topLeft.x - padding,
    topLeft.y - padding,
    width + padding * 2,
    height + padding * 2
  );
  ctx.setLineDash([]);

  // Draw label if specified
  if (annotation.label) {
    const labelFontSize = 12 * transform.scale;
    ctx.font = `${labelFontSize}px system-ui, -apple-system, sans-serif`;
    ctx.fillStyle = '#888';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText(annotation.label, topLeft.x - padding + 4, topLeft.y - padding - 2);
  }

  // Draw selection handles if selected
  if (isSelected) {
    drawSelectionRect(ctx, topLeft.x - padding, topLeft.y - padding, width + padding * 2, height + padding * 2);
    drawHandle(ctx, topLeft.x - padding, topLeft.y - padding);
    drawHandle(ctx, bottomRight.x + padding, topLeft.y - padding);
    drawHandle(ctx, topLeft.x - padding, bottomRight.y + padding);
    drawHandle(ctx, bottomRight.x + padding, bottomRight.y + padding);
  }
}

/**
 * Get bounding box for an annotation in world coordinates
 */
function getAnnotationBounds(annotation: Annotation): { x: number; y: number; width: number; height: number } {
  switch (annotation.type) {
    case 'text': {
      const text = annotation as TextAnnotation;
      if (!text.position) return { x: 0, y: 0, width: 0, height: 0 };
      // Estimate text bounds (actual measurement requires canvas context)
      const lines = (text.content || '').split('\n');
      const width = Math.max(...lines.map(l => l.length * (text.fontSize || 16) * 0.6));
      const height = lines.length * (text.fontSize || 16) * 1.2;
      return { x: text.position.x, y: text.position.y, width, height };
    }
    case 'shape': {
      const shape = annotation as ShapeAnnotation;
      if (!shape.position || !shape.size) return { x: 0, y: 0, width: 0, height: 0 };
      return { x: shape.position.x, y: shape.position.y, width: shape.size.width, height: shape.size.height };
    }
    case 'line': {
      const line = annotation as LineAnnotation;
      if (!line.points || line.points.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const p of line.points) {
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x);
        maxY = Math.max(maxY, p.y);
      }
      return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
    }
    default:
      return { x: 0, y: 0, width: 0, height: 0 };
  }
}

/**
 * Draw an arrow head at a point
 */
function drawArrowHead(
  ctx: CanvasRenderingContext2D,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  color: string,
  lineWidth: number
): void {
  const angle = Math.atan2(toY - fromY, toX - fromX);
  const size = ARROW_SIZE + lineWidth;

  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(toX, toY);
  ctx.lineTo(
    toX - size * Math.cos(angle - Math.PI / 6),
    toY - size * Math.sin(angle - Math.PI / 6)
  );
  ctx.lineTo(
    toX - size * Math.cos(angle + Math.PI / 6),
    toY - size * Math.sin(angle + Math.PI / 6)
  );
  ctx.closePath();
  ctx.fill();
}

/**
 * Draw selection rectangle outline
 */
function drawSelectionRect(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number): void {
  ctx.strokeStyle = '#4a9eff';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.strokeRect(x - SELECTION_PADDING, y - SELECTION_PADDING, width + SELECTION_PADDING * 2, height + SELECTION_PADDING * 2);
  ctx.setLineDash([]);
}

/**
 * Draw a selection handle (small square)
 */
function drawHandle(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  ctx.fillStyle = '#fff';
  ctx.strokeStyle = '#4a9eff';
  ctx.lineWidth = 1;
  ctx.fillRect(x - HANDLE_SIZE / 2, y - HANDLE_SIZE / 2, HANDLE_SIZE, HANDLE_SIZE);
  ctx.strokeRect(x - HANDLE_SIZE / 2, y - HANDLE_SIZE / 2, HANDLE_SIZE, HANDLE_SIZE);
}

/**
 * Render all annotations on the canvas
 * Annotations are sorted by z-index (lowest first = rendered first = appears behind)
 */
export function renderAnnotations(
  ctx: CanvasRenderingContext2D,
  annotations: Annotation[],
  transform: CanvasTransform,
  selectedAnnotationId?: string
): void {
  // Sort by z-index (ascending - lower z-index rendered first)
  const sorted = [...annotations].sort((a, b) => a.zIndex - b.zIndex);

  for (const annotation of sorted) {
    const isSelected = annotation.id === selectedAnnotationId;

    switch (annotation.type) {
      case 'text':
        renderTextAnnotation(ctx, annotation as TextAnnotation, transform, isSelected);
        break;
      case 'shape':
        renderShapeAnnotation(ctx, annotation as ShapeAnnotation, transform, isSelected);
        break;
      case 'line':
        renderLineAnnotation(ctx, annotation as LineAnnotation, transform, isSelected);
        break;
      case 'group':
        renderGroupAnnotation(ctx, annotation as GroupAnnotation, transform, isSelected, annotations);
        break;
    }
  }
}

/**
 * Calculate distance from a point to a line segment
 */
function distanceToLineSegment(
  px: number, py: number,
  x1: number, y1: number,
  x2: number, y2: number
): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSquared = dx * dx + dy * dy;

  if (lengthSquared === 0) {
    return Math.sqrt((px - x1) * (px - x1) + (py - y1) * (py - y1));
  }

  let t = ((px - x1) * dx + (py - y1) * dy) / lengthSquared;
  t = Math.max(0, Math.min(1, t));

  const closestX = x1 + t * dx;
  const closestY = y1 + t * dy;

  return Math.sqrt((px - closestX) * (px - closestX) + (py - closestY) * (py - closestY));
}

/**
 * Hit test for line annotations - uses distance from line path
 */
function hitTestLine(
  annotation: LineAnnotation,
  screenX: number,
  screenY: number,
  transform: CanvasTransform,
  threshold: number = 10
): boolean {
  const points = annotation.points;
  if (!points || points.length < 2) return false;

  // Test distance to each segment
  for (let i = 0; i < points.length - 1; i++) {
    const p1 = worldToScreen(points[i].x, points[i].y, transform);
    const p2 = worldToScreen(points[i + 1].x, points[i + 1].y, transform);
    const dist = distanceToLineSegment(screenX, screenY, p1.x, p1.y, p2.x, p2.y);
    if (dist <= threshold) {
      return true;
    }
  }

  return false;
}

/**
 * Hit test for annotations - find annotation at screen position
 * Returns the topmost (highest z-index) annotation at the position
 * Prioritizes text/shape over lines for better UX
 */
export function hitTestAnnotation(
  annotations: Annotation[],
  screenX: number,
  screenY: number,
  transform: CanvasTransform
): Annotation | null {
  // Separate annotations by type for prioritized testing
  const textAnnotations: TextAnnotation[] = [];
  const shapeAnnotations: ShapeAnnotation[] = [];
  const lineAnnotations: LineAnnotation[] = [];
  const groupAnnotations: GroupAnnotation[] = [];

  for (const a of annotations) {
    switch (a.type) {
      case 'text': textAnnotations.push(a as TextAnnotation); break;
      case 'shape': shapeAnnotations.push(a as ShapeAnnotation); break;
      case 'line': lineAnnotations.push(a as LineAnnotation); break;
      case 'group': groupAnnotations.push(a as GroupAnnotation); break;
    }
  }

  // Sort each group by z-index (highest first)
  textAnnotations.sort((a, b) => b.zIndex - a.zIndex);
  shapeAnnotations.sort((a, b) => b.zIndex - a.zIndex);
  lineAnnotations.sort((a, b) => b.zIndex - a.zIndex);

  // Test text annotations first (most specific, likely what user wants to edit)
  for (const annotation of textAnnotations) {
    const bounds = getAnnotationBounds(annotation);
    const topLeft = worldToScreen(bounds.x, bounds.y, transform);
    const bottomRight = worldToScreen(bounds.x + bounds.width, bounds.y + bounds.height, transform);
    const padding = 5;
    if (
      screenX >= topLeft.x - padding &&
      screenX <= bottomRight.x + padding &&
      screenY >= topLeft.y - padding &&
      screenY <= bottomRight.y + padding
    ) {
      return annotation;
    }
  }

  // Test shape annotations second
  for (const annotation of shapeAnnotations) {
    const bounds = getAnnotationBounds(annotation);
    const topLeft = worldToScreen(bounds.x, bounds.y, transform);
    const bottomRight = worldToScreen(bounds.x + bounds.width, bounds.y + bounds.height, transform);
    const padding = 5;
    if (
      screenX >= topLeft.x - padding &&
      screenX <= bottomRight.x + padding &&
      screenY >= topLeft.y - padding &&
      screenY <= bottomRight.y + padding
    ) {
      return annotation;
    }
  }

  // Test line annotations last (use distance-based hit testing)
  for (const annotation of lineAnnotations) {
    if (hitTestLine(annotation, screenX, screenY, transform)) {
      return annotation;
    }
  }

  return null;
}

export default {
  renderAnnotations,
  hitTestAnnotation,
};
