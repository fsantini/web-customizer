// Parses the OpenSCAD "Customizer" convention out of a .scad source file.
// Reference: https://github.com/openscad/openscad/wiki/Customizer

const GROUP_RE = /^\s*\/\*\s*\[(.+?)\]\s*\*\/\s*$/;
const FULL_LINE_COMMENT_RE = /^\s*\/\/\s?(.*)$/;
const VAR_RE = /^(\s*)(\$?[A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+?);(?:\s*\/\/\s*(.*?)\s*)?$/;
const DEF_START_RE = /^\s*(module|function)\s+[A-Za-z_][A-Za-z0-9_]*\s*\(/;

function splitTopLevel(text, sep) {
  const parts = [];
  let depth = 0;
  let inString = false;
  let current = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      current += c;
      if (c === '\\') {
        current += text[++i] ?? '';
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }
    if (c === '"') {
      inString = true;
      current += c;
      continue;
    }
    if (c === '[' || c === '(') depth++;
    if (c === ']' || c === ')') depth--;
    if (c === sep && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += c;
    }
  }
  if (current.length) parts.push(current);
  return parts.map((s) => s.trim()).filter((s) => s.length > 0);
}

function parseScalar(raw) {
  const s = raw.trim();
  if (s === 'true') return { type: 'boolean', value: true };
  if (s === 'false') return { type: 'boolean', value: false };
  if (/^".*"$/.test(s)) {
    try {
      return { type: 'string', value: JSON.parse(s) };
    } catch {
      return { type: 'string', value: s.slice(1, -1) };
    }
  }
  const n = Number(s);
  if (!Number.isNaN(n) && s !== '') return { type: 'number', value: n };
  return { type: 'unsupported', value: s };
}

function parseValue(raw) {
  const s = raw.trim();
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1);
    const items = splitTopLevel(inner, ',').map(parseScalar);
    if (items.every((i) => i.type !== 'unsupported')) {
      return { type: 'vector', value: items.map((i) => i.value), itemTypes: items.map((i) => i.type) };
    }
    return { type: 'unsupported', value: s };
  }
  return parseScalar(s);
}

function parseSpec(comment, valueType) {
  if (!comment) return null;
  const m = comment.match(/^\[(.*)\]$/);
  if (!m) return null;
  const content = m[1];

  const rangeParts = content.split(':');
  const isNumericRange =
    rangeParts.length >= 2 &&
    rangeParts.length <= 3 &&
    rangeParts.every((p) => p.trim() !== '' && !Number.isNaN(Number(p.trim())));

  if (isNumericRange && (valueType === 'number' || valueType === 'vector')) {
    const nums = rangeParts.map((p) => Number(p.trim()));
    if (nums.length === 2) return { kind: 'range', min: nums[0], max: nums[1], step: 1 };
    return { kind: 'range', min: nums[0], max: nums[2], step: nums[1] };
  }

  const rawOptions = splitTopLevel(content, ',');
  const options = rawOptions.map((opt) => {
    const idx = opt.indexOf(':');
    if (idx === -1) {
      const parsed = parseScalar(opt);
      return { value: parsed.value, label: opt.replace(/^"|"$/g, '') };
    }
    const valuePart = opt.slice(0, idx).trim();
    const labelPart = opt.slice(idx + 1).trim();
    const parsed = parseScalar(valuePart);
    return { value: parsed.value, label: labelPart };
  });
  return { kind: 'options', options };
}

export function parseCustomizer(sourceText) {
  const lines = sourceText.split('\n');
  const params = [];
  let currentGroup = 'Parameters';
  let pendingDescription = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (DEF_START_RE.test(line)) break;

    const groupMatch = line.match(GROUP_RE);
    if (groupMatch) {
      currentGroup = groupMatch[1].trim();
      pendingDescription = [];
      continue;
    }

    if (line.trim() === '') {
      continue;
    }

    const varMatch = line.match(VAR_RE);
    if (varMatch) {
      const [, indent, name, rawValue, comment] = varMatch;
      const parsedValue = parseValue(rawValue);
      if (parsedValue.type !== 'unsupported') {
        const spec = parseSpec(comment, parsedValue.type);
        params.push({
          name,
          lineIndex: i,
          indent,
          group: currentGroup,
          hidden: currentGroup.toLowerCase() === 'hidden',
          description: pendingDescription.join(' ') || null,
          type: parsedValue.type,
          itemTypes: parsedValue.itemTypes,
          defaultValue: parsedValue.value,
          spec,
          originalComment: comment || null,
        });
      }
      pendingDescription = [];
      continue;
    }

    const commentMatch = line.match(FULL_LINE_COMMENT_RE);
    if (commentMatch) {
      pendingDescription.push(commentMatch[1]);
      continue;
    }

    // Any other statement resets pending description context but keeps scanning
    // (e.g. blank-ish lines already handled above).
    pendingDescription = [];
  }

  return { lines, params };
}

function formatNumber(n) {
  if (Number.isInteger(n)) return String(n);
  let s = n.toFixed(6);
  s = s.replace(/0+$/, '').replace(/\.$/, '');
  return s;
}

function formatScalar(value, type) {
  if (type === 'boolean') return value ? 'true' : 'false';
  if (type === 'string') return JSON.stringify(String(value));
  if (type === 'number') return formatNumber(Number(value));
  return String(value);
}

function formatValue(value, param) {
  if (param.type === 'vector') {
    const items = value.map((v, idx) => formatScalar(v, param.itemTypes[idx] || 'number'));
    return `[${items.join(', ')}]`;
  }
  return formatScalar(value, param.type);
}

// Builds a full .scad source string with the given parameter values substituted
// on their original lines. `values` maps param name -> current value.
// `overrides` optionally maps param name -> literal value to force (used for
// capping $fn during fast preview renders).
export function buildSource(parsed, values, overrides = {}) {
  const outLines = parsed.lines.slice();
  for (const param of parsed.params) {
    const value = Object.prototype.hasOwnProperty.call(overrides, param.name)
      ? overrides[param.name]
      : values[param.name];
    const literal = formatValue(value, param);
    const commentSuffix = param.originalComment !== null ? ` // ${param.originalComment}` : '';
    outLines[param.lineIndex] = `${param.indent}${param.name} = ${literal};${commentSuffix}`;
  }
  return outLines.join('\n');
}
