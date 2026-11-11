/**
 * Jinja2 Variable Extractor
 * Extracts variable names from Jinja2 templates for user prompting
 */

export interface ExtractedVariable {
  name: string;
  fullExpression: string;
  filters: string[];
  line: number;
  isLoop: boolean;
  loopVariable?: string;
}

/**
 * Extract all variables from a Jinja2 template
 */
export function extractJinjaVariables(template: string): ExtractedVariable[] {
  const variables: ExtractedVariable[] = [];
  const seenNames = new Set<string>();
  const lines = template.split('\n');

  // Track loop variables that shouldn't be prompted
  const loopVariables = new Set<string>();

  // First pass: identify loop variables
  const forLoopRegex = /\{%\s*for\s+(\w+)(?:\s*,\s*(\w+))?\s+in\s+(\w+(?:\.\w+)*)/g;
  for (let lineNum = 0; lineNum < lines.length; lineNum++) {
    const line = lines[lineNum];
    let match;
    while ((match = forLoopRegex.exec(line)) !== null) {
      // Add loop variable(s) to exclusion set
      if (match[1]) loopVariables.add(match[1]);
      if (match[2]) loopVariables.add(match[2]);
    }
  }

  // Second pass: extract variables from {{ }} expressions
  const varRegex = /\{\{\s*([^}]+)\s*\}\}/g;
  for (let lineNum = 0; lineNum < lines.length; lineNum++) {
    const line = lines[lineNum];
    let match;
    while ((match = varRegex.exec(line)) !== null) {
      const fullExpression = match[1].trim();
      const parsed = parseExpression(fullExpression);

      // Skip if it's a loop variable or already seen
      if (loopVariables.has(parsed.rootName) || seenNames.has(parsed.rootName)) {
        continue;
      }

      seenNames.add(parsed.rootName);
      variables.push({
        name: parsed.rootName,
        fullExpression,
        filters: parsed.filters,
        line: lineNum + 1,
        isLoop: false,
      });
    }
  }

  // Third pass: extract loop source variables from {% for %}
  for (let lineNum = 0; lineNum < lines.length; lineNum++) {
    const line = lines[lineNum];
    let match;
    const forLoopRegex2 = /\{%\s*for\s+\w+(?:\s*,\s*\w+)?\s+in\s+(\w+)(?:\.(\w+))*/g;
    while ((match = forLoopRegex2.exec(line)) !== null) {
      const rootName = match[1];
      if (!seenNames.has(rootName) && !loopVariables.has(rootName)) {
        seenNames.add(rootName);
        variables.push({
          name: rootName,
          fullExpression: match[0],
          filters: [],
          line: lineNum + 1,
          isLoop: true,
        });
      }
    }
  }

  // Fourth pass: extract variables from {% if %} conditions
  const ifRegex = /\{%\s*if\s+([^%]+)\s*%\}/g;
  for (let lineNum = 0; lineNum < lines.length; lineNum++) {
    const line = lines[lineNum];
    let match;
    while ((match = ifRegex.exec(line)) !== null) {
      const condition = match[1].trim();
      // Extract variable names from condition (simple extraction)
      const conditionVars = condition.match(/\b([a-zA-Z_][a-zA-Z0-9_]*)\b/g) || [];
      for (const varName of conditionVars) {
        // Skip keywords and already seen variables
        if (isJinjaKeyword(varName) || seenNames.has(varName) || loopVariables.has(varName)) {
          continue;
        }
        seenNames.add(varName);
        variables.push({
          name: varName,
          fullExpression: condition,
          filters: [],
          line: lineNum + 1,
          isLoop: false,
        });
      }
    }
  }

  return variables;
}

/**
 * Parse a Jinja expression to get the root variable name and filters
 */
function parseExpression(expr: string): { rootName: string; filters: string[] } {
  // Split by pipe for filters
  const parts = expr.split('|').map(p => p.trim());
  const mainPart = parts[0];
  const filters = parts.slice(1);

  // Get root variable name (before any dots or brackets)
  const rootMatch = mainPart.match(/^([a-zA-Z_][a-zA-Z0-9_]*)/);
  const rootName = rootMatch ? rootMatch[1] : mainPart;

  return { rootName, filters };
}

/**
 * Check if a name is a Jinja keyword
 */
function isJinjaKeyword(name: string): boolean {
  const keywords = [
    'true', 'false', 'True', 'False', 'none', 'None',
    'and', 'or', 'not', 'in', 'is',
    'if', 'else', 'elif', 'endif',
    'for', 'endfor', 'loop',
    'block', 'endblock', 'extends', 'include',
    'macro', 'endmacro', 'call', 'endcall',
    'filter', 'endfilter', 'set', 'endset',
    'raw', 'endraw', 'with', 'endwith',
  ];
  return keywords.includes(name);
}

/**
 * Infer variable type from context (for UI hints)
 */
export function inferVariableType(variable: ExtractedVariable): 'string' | 'number' | 'boolean' | 'array' | 'object' {
  if (variable.isLoop) {
    return 'array';
  }

  // Check filters for type hints
  const filters = variable.filters.map(f => f.toLowerCase());
  if (filters.some(f => f.includes('int') || f.includes('float') || f.includes('round'))) {
    return 'number';
  }
  if (filters.some(f => f.includes('bool'))) {
    return 'boolean';
  }
  if (filters.some(f => f.includes('join') || f.includes('first') || f.includes('last') || f.includes('length'))) {
    return 'array';
  }

  // Default to string
  return 'string';
}
