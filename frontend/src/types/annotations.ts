// Annotation types for topology visual documentation
// Supports text labels, shapes, and freeform lines

/**
 * Annotation type discriminator
 */
export type AnnotationType = 'text' | 'shape' | 'line' | 'group';

/**
 * Base annotation properties shared by all annotation types
 */
export interface BaseAnnotation {
  /** Unique annotation identifier */
  id: string;
  /** Parent topology ID */
  topologyId: string;
  /** Annotation type discriminator */
  type: AnnotationType;
  /** Z-index for layering (higher = in front) */
  zIndex: number;
  /** Creation timestamp */
  createdAt: string;
  /** Last update timestamp */
  updatedAt: string;
}

/**
 * Text annotation for labels and callouts
 */
export interface TextAnnotation extends BaseAnnotation {
  type: 'text';
  /** Position on canvas */
  position: { x: number; y: number };
  /** Text content */
  content: string;
  /** Font size (10-72) */
  fontSize: number;
  /** Font weight */
  fontWeight: 'normal' | 'bold';
  /** Text color (hex) */
  color: string;
  /** Background color for callout box (optional) */
  backgroundColor?: string;
  /** Attached device or connection ID (optional) */
  attachedTo?: string;
  /** Font family */
  fontFamily?: FontFamily;
  /** Font style (normal or italic) */
  fontStyle?: 'normal' | 'italic';
  /** Text alignment */
  textAlign?: TextAlign;
  /** Opacity (0-1) */
  opacity?: number;
}

/**
 * Shape type for shape annotations
 */
export type ShapeType = 'rectangle' | 'circle' | 'diamond' | 'arrow' | 'cloud';

/**
 * Line style for strokes
 */
export type StrokeStyle = 'solid' | 'dashed' | 'dotted';

/**
 * Font family options
 */
export type FontFamily = 'sans-serif' | 'serif' | 'monospace';

/**
 * Text alignment options
 */
export type TextAlign = 'left' | 'center' | 'right';

/**
 * Shape annotation for rectangles, circles, diamonds, arrows, and clouds
 */
export interface ShapeAnnotation extends BaseAnnotation {
  type: 'shape';
  /** Shape type */
  shapeType: ShapeType;
  /** Position on canvas (top-left corner) */
  position: { x: number; y: number };
  /** Size of the shape */
  size: { width: number; height: number };
  /** Fill color (optional) */
  fillColor?: string;
  /** Stroke/border color */
  strokeColor: string;
  /** Stroke style */
  strokeStyle: StrokeStyle;
  /** Stroke width in pixels */
  strokeWidth: number;
  /** Label text inside shape (optional) */
  label?: string;
  /** Fill opacity (0-1) */
  fillOpacity?: number;
  /** Stroke opacity (0-1) */
  strokeOpacity?: number;
  /** Label text color */
  labelColor?: string;
  /** Label font size */
  labelFontSize?: number;
  /** Border radius for rectangles */
  borderRadius?: number;
}

/**
 * Line annotation for freeform paths and connectors
 */
export interface LineAnnotation extends BaseAnnotation {
  type: 'line';
  /** Points defining the line path */
  points: { x: number; y: number }[];
  /** Curve style */
  curveStyle: 'straight' | 'curved';
  /** Line color */
  color: string;
  /** Line style */
  lineStyle: StrokeStyle;
  /** Line width in pixels */
  lineWidth: number;
  /** Show arrow at start point */
  arrowStart?: boolean;
  /** Show arrow at end point */
  arrowEnd?: boolean;
  /** Opacity (0-1) */
  opacity?: number;
}

/**
 * Group annotation for grouping multiple annotations
 */
export interface GroupAnnotation extends BaseAnnotation {
  type: 'group';
  /** IDs of grouped annotations */
  memberIds: string[];
  /** Group label (optional) */
  label?: string;
}

/**
 * Union type for all annotation types
 */
export type Annotation = TextAnnotation | ShapeAnnotation | LineAnnotation | GroupAnnotation;

/**
 * Request to create a new annotation
 */
export interface CreateAnnotationRequest {
  type: AnnotationType;
  zIndex?: number;
  elementData: Omit<TextAnnotation, keyof BaseAnnotation>
    | Omit<ShapeAnnotation, keyof BaseAnnotation>
    | Omit<LineAnnotation, keyof BaseAnnotation>
    | Omit<GroupAnnotation, keyof BaseAnnotation>;
}

/**
 * Request to update an annotation
 */
export interface UpdateAnnotationRequest {
  zIndex?: number;
  elementData?: Partial<Omit<TextAnnotation, keyof BaseAnnotation>>
    | Partial<Omit<ShapeAnnotation, keyof BaseAnnotation>>
    | Partial<Omit<LineAnnotation, keyof BaseAnnotation>>
    | Partial<Omit<GroupAnnotation, keyof BaseAnnotation>>;
}

/**
 * Type guard for TextAnnotation
 */
export function isTextAnnotation(annotation: Annotation): annotation is TextAnnotation {
  return annotation.type === 'text';
}

/**
 * Type guard for ShapeAnnotation
 */
export function isShapeAnnotation(annotation: Annotation): annotation is ShapeAnnotation {
  return annotation.type === 'shape';
}

/**
 * Type guard for LineAnnotation
 */
export function isLineAnnotation(annotation: Annotation): annotation is LineAnnotation {
  return annotation.type === 'line';
}

/**
 * Type guard for GroupAnnotation
 */
export function isGroupAnnotation(annotation: Annotation): annotation is GroupAnnotation {
  return annotation.type === 'group';
}
