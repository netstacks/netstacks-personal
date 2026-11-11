/**
 * DetailSections - Renders detail sections from provider architecture
 *
 * Presentational component that renders DetailSection[] as titled groups
 * with label/value rows. Supports links, badges, and tone colors.
 */

import type { DetailSection } from '../../lib/detail/types';
import './DetailSections.css';

interface DetailSectionsProps {
  /** Sections to render (already sorted by priority) */
  sections: DetailSection[];
}

/**
 * Renders detail sections as titled groups with styled fields
 */
export default function DetailSections({ sections }: DetailSectionsProps) {
  return (
    <div className="detail-sections">
      {sections.map((section) => (
        <div key={section.id} className="device-detail-card-section">
          <div className="device-detail-card-section-title">{section.title}</div>
          <div className="device-detail-card-info-grid">
            {section.fields.map((field) => (
              <div key={field.key} className="device-detail-card-info-row">
                <span className="device-detail-card-info-label">{field.label}</span>
                <span className="device-detail-card-info-value">
                  {renderFieldValue(field)}
                </span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Render a field value based on kind and tone
 */
function renderFieldValue(field: DetailSection['fields'][0]) {
  // Link kind
  if (field.kind === 'link' && field.href) {
    return (
      <a
        href={field.href}
        target="_blank"
        rel="noopener noreferrer"
        className="detail-field-link"
      >
        {field.value}
      </a>
    );
  }

  // Badge kind or any field with a tone
  if (field.kind === 'badge' || field.tone) {
    const tone = field.tone || 'default';
    return (
      <span className={`detail-field-badge detail-field-tone-${tone}`}>
        {field.value}
      </span>
    );
  }

  // Plain text
  return field.value;
}
