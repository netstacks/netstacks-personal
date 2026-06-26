/**
 * AnnotationPropertiesPanel - Side panel for editing annotation properties
 *
 * Displays type-specific controls based on the selected annotation type.
 */

import type {
  Annotation,
  TextAnnotation,
  ShapeAnnotation,
  LineAnnotation,
} from '../../types/annotations';
import ColorPickerWithOpacity from './properties/ColorPickerWithOpacity';
import FontSelector from './properties/FontSelector';
import TextAlignSelector from './properties/TextAlignSelector';
import StrokeStyleSelector from './properties/StrokeStyleSelector';
import NumberInput from './properties/NumberInput';
import './AnnotationPropertiesPanel.css';

interface AnnotationPropertiesPanelProps {
  annotation: Annotation;
  onUpdate: (updates: Partial<Annotation>) => void;
  onClose: () => void;
}

export default function AnnotationPropertiesPanel({
  annotation,
  onUpdate,
  onClose,
}: AnnotationPropertiesPanelProps) {
  const getTypeIcon = () => {
    switch (annotation.type) {
      case 'text':
        return (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
            <polyline points="4 7 4 4 20 4 20 7" />
            <line x1="9" y1="20" x2="15" y2="20" />
            <line x1="12" y1="4" x2="12" y2="20" />
          </svg>
        );
      case 'shape':
        return (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
            <rect x="3" y="3" width="18" height="18" rx="2" />
          </svg>
        );
      case 'line':
        return (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
            <line x1="5" y1="19" x2="19" y2="5" />
          </svg>
        );
      default:
        return null;
    }
  };

  const getTypeLabel = () => {
    switch (annotation.type) {
      case 'text':
        return 'Text';
      case 'shape':
        return (annotation as ShapeAnnotation).shapeType.charAt(0).toUpperCase() +
          (annotation as ShapeAnnotation).shapeType.slice(1);
      case 'line':
        return 'Line';
      default:
        return 'Annotation';
    }
  };

  return (
    <div className="annotation-properties-panel">
      <div className="annotation-properties-header">
        <div className="annotation-properties-title">
          {getTypeIcon()}
          <span>{getTypeLabel()} Properties</span>
        </div>
        <button className="annotation-properties-close" onClick={onClose} title="Close">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      <div className="annotation-properties-content">
        {annotation.type === 'text' && (
          <TextAnnotationProperties
            annotation={annotation as TextAnnotation}
            onUpdate={onUpdate}
          />
        )}
        {annotation.type === 'shape' && (
          <ShapeAnnotationProperties
            annotation={annotation as ShapeAnnotation}
            onUpdate={onUpdate}
          />
        )}
        {annotation.type === 'line' && (
          <LineAnnotationProperties
            annotation={annotation as LineAnnotation}
            onUpdate={onUpdate}
          />
        )}
      </div>
    </div>
  );
}

// Text annotation properties
function TextAnnotationProperties({
  annotation,
  onUpdate,
}: {
  annotation: TextAnnotation;
  onUpdate: (updates: Partial<TextAnnotation>) => void;
}) {
  return (
    <>
      <section className="properties-section">
        <h4 className="properties-section-title">Content</h4>
        <textarea
          className="properties-textarea"
          value={annotation.content}
          onChange={(e) => onUpdate({ content: e.target.value })}
          rows={3}
          placeholder="Enter text..."
        />
      </section>

      <section className="properties-section">
        <h4 className="properties-section-title">Font</h4>
        <FontSelector
          fontFamily={annotation.fontFamily || 'sans-serif'}
          fontSize={annotation.fontSize}
          fontWeight={annotation.fontWeight}
          fontStyle={annotation.fontStyle || 'normal'}
          onFontFamilyChange={(fontFamily) => onUpdate({ fontFamily })}
          onFontSizeChange={(fontSize) => onUpdate({ fontSize })}
          onFontWeightChange={(fontWeight) => onUpdate({ fontWeight })}
          onFontStyleChange={(fontStyle) => onUpdate({ fontStyle })}
        />
      </section>

      <section className="properties-section">
        <TextAlignSelector
          value={annotation.textAlign || 'left'}
          onChange={(textAlign) => onUpdate({ textAlign })}
        />
      </section>

      <section className="properties-section">
        <h4 className="properties-section-title">Colors</h4>
        <ColorPickerWithOpacity
          color={annotation.color}
          opacity={annotation.opacity ?? 1}
          onColorChange={(color) => onUpdate({ color })}
          onOpacityChange={(opacity) => onUpdate({ opacity })}
          label="Text Color"
        />
        <div className="properties-spacer" />
        <ColorPickerWithOpacity
          color={annotation.backgroundColor || '#00000000'}
          onColorChange={(backgroundColor) => onUpdate({ backgroundColor: backgroundColor === '#00000000' ? undefined : backgroundColor })}
          label="Background"
          showOpacity={false}
        />
      </section>
    </>
  );
}

// Shape annotation properties
function ShapeAnnotationProperties({
  annotation,
  onUpdate,
}: {
  annotation: ShapeAnnotation;
  onUpdate: (updates: Partial<ShapeAnnotation>) => void;
}) {
  return (
    <>
      <section className="properties-section">
        <h4 className="properties-section-title">Fill</h4>
        <ColorPickerWithOpacity
          color={annotation.fillColor || '#ffffff'}
          opacity={annotation.fillOpacity ?? 1}
          onColorChange={(fillColor) => onUpdate({ fillColor })}
          onOpacityChange={(fillOpacity) => onUpdate({ fillOpacity })}
          label="Color"
        />
      </section>

      <section className="properties-section">
        <h4 className="properties-section-title">Stroke</h4>
        <ColorPickerWithOpacity
          color={annotation.strokeColor}
          opacity={annotation.strokeOpacity ?? 1}
          onColorChange={(strokeColor) => onUpdate({ strokeColor })}
          onOpacityChange={(strokeOpacity) => onUpdate({ strokeOpacity })}
          label="Color"
        />
        <div className="properties-spacer" />
        <StrokeStyleSelector
          value={annotation.strokeStyle}
          onChange={(strokeStyle) => onUpdate({ strokeStyle })}
        />
        <div className="properties-spacer" />
        <NumberInput
          value={annotation.strokeWidth}
          onChange={(strokeWidth) => onUpdate({ strokeWidth })}
          min={1}
          max={20}
          step={1}
          label="Width"
          unit="px"
        />
      </section>

      {annotation.shapeType === 'rectangle' && (
        <section className="properties-section">
          <h4 className="properties-section-title">Corners</h4>
          <NumberInput
            value={annotation.borderRadius || 0}
            onChange={(borderRadius) => onUpdate({ borderRadius })}
            min={0}
            max={50}
            step={1}
            label="Radius"
            unit="px"
          />
        </section>
      )}

      <section className="properties-section">
        <h4 className="properties-section-title">Label</h4>
        <input
          type="text"
          className="properties-input"
          value={annotation.label || ''}
          onChange={(e) => onUpdate({ label: e.target.value || undefined })}
          placeholder="Enter label..."
        />
        {annotation.label && (
          <>
            <div className="properties-spacer" />
            <ColorPickerWithOpacity
              color={annotation.labelColor || annotation.strokeColor}
              onColorChange={(labelColor) => onUpdate({ labelColor })}
              label="Label Color"
              showOpacity={false}
            />
            <div className="properties-spacer" />
            <NumberInput
              value={annotation.labelFontSize || 14}
              onChange={(labelFontSize) => onUpdate({ labelFontSize })}
              min={8}
              max={48}
              step={1}
              label="Label Size"
              unit="px"
            />
          </>
        )}
      </section>
    </>
  );
}

// Line annotation properties
function LineAnnotationProperties({
  annotation,
  onUpdate,
}: {
  annotation: LineAnnotation;
  onUpdate: (updates: Partial<LineAnnotation>) => void;
}) {
  return (
    <>
      <section className="properties-section">
        <h4 className="properties-section-title">Line</h4>
        <ColorPickerWithOpacity
          color={annotation.color}
          opacity={annotation.opacity ?? 1}
          onColorChange={(color) => onUpdate({ color })}
          onOpacityChange={(opacity) => onUpdate({ opacity })}
          label="Color"
        />
        <div className="properties-spacer" />
        <StrokeStyleSelector
          value={annotation.lineStyle}
          onChange={(lineStyle) => onUpdate({ lineStyle })}
        />
        <div className="properties-spacer" />
        <NumberInput
          value={annotation.lineWidth}
          onChange={(lineWidth) => onUpdate({ lineWidth })}
          min={1}
          max={20}
          step={1}
          label="Width"
          unit="px"
        />
      </section>

      <section className="properties-section">
        <h4 className="properties-section-title">Curve</h4>
        <div className="properties-toggle-group">
          <button
            type="button"
            className={`properties-toggle-btn ${annotation.curveStyle === 'straight' ? 'active' : ''}`}
            onClick={() => onUpdate({ curveStyle: 'straight' })}
          >
            Straight
          </button>
          <button
            type="button"
            className={`properties-toggle-btn ${annotation.curveStyle === 'curved' ? 'active' : ''}`}
            onClick={() => onUpdate({ curveStyle: 'curved' })}
          >
            Curved
          </button>
        </div>
      </section>

      <section className="properties-section">
        <h4 className="properties-section-title">Arrows</h4>
        <div className="properties-checkbox-group">
          <label className="properties-checkbox">
            <input
              type="checkbox"
              checked={annotation.arrowStart || false}
              onChange={(e) => onUpdate({ arrowStart: e.target.checked })}
            />
            <span>Arrow at Start</span>
          </label>
          <label className="properties-checkbox">
            <input
              type="checkbox"
              checked={annotation.arrowEnd || false}
              onChange={(e) => onUpdate({ arrowEnd: e.target.checked })}
            />
            <span>Arrow at End</span>
          </label>
        </div>
      </section>
    </>
  );
}
