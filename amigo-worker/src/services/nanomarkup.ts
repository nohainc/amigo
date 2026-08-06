/**
 * A TypeScript implementation of the Nano Markup parser.
 * Normative spec: https://github.com/nohainc/nanomarkup.spec
 */

type Value = string | Mapping | Sequence;
interface Mapping {
  [key: string]: Value;
}
type Sequence = Value[];

export function parseNano(source: string): any {
  // Normalize CRLF to LF
  const lines = source.replace(/\r\n/g, "\n").split("\n");

  let root: any = null;
  const stack: { level: number; value: any; key?: string; isMultiline?: boolean; multilineHeaderLevel?: number; multilineLines?: string[] }[] = [];

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const rawLine = lines[lineIndex];

    // Check for blank line
    if (/^\s*$/.test(rawLine)) {
      // If we are currently parsing a multiline string, blank lines are part of the content
      const current = stack[stack.length - 1];
      if (current && current.isMultiline) {
        current.multilineLines?.push("");
      }
      continue;
    }

    // Check for comment
    const commentMatch = rawLine.match(/^(\s*)#/);
    if (commentMatch) {
      // Ignore comment lines unless we are in a multiline block
      const current = stack[stack.length - 1];
      if (current && current.isMultiline) {
        // In multiline blocks, # is treated as ordinary string data if it's indented enough
        const indent = rawLine.match(/^ */)?.[0].length || 0;
        const requiredIndent = (current.multilineHeaderLevel || 0) + 4;
        if (indent >= requiredIndent) {
          current.multilineLines?.push(rawLine.slice(requiredIndent));
        }
      }
      continue;
    }

    // Determine indentation
    const indentMatch = rawLine.match(/^( *)/);
    const indentSpaces = indentMatch ? indentMatch[1].length : 0;
    if (indentSpaces % 4 !== 0) {
      throw new Error(`Line ${lineIndex + 1}: Indentation must be a multiple of 4 spaces: "${rawLine}"`);
    }
    const level = indentSpaces / 4;
    const content = rawLine.slice(indentSpaces);

    // Handle open multiline string parsing
    const current = stack[stack.length - 1];
    if (current && current.isMultiline) {
      const requiredIndent = (current.multilineHeaderLevel || 0) + 4;
      if (indentSpaces >= requiredIndent) {
        // Content of multiline string
        // Preserve any spaces beyond the required indentation
        current.multilineLines?.push(rawLine.slice(requiredIndent));
        continue;
      } else {
        // Dedent: close the multiline string and save it
        closeMultilineString(stack);
      }
    }

    // Pop the stack until we find the parent container
    while (stack.length > 0 && stack[stack.length - 1].level >= level) {
      const popped = stack.pop();
      if (popped?.isMultiline) {
        // If we popped a multiline, close it first
        finalizeMultiline(popped);
      }
    }

    const parent = stack[stack.length - 1];

    // If root is not set, this is the root node
    if (!root) {
      if (level !== 0) {
        throw new Error(`Line ${lineIndex + 1}: Root must be at indentation level 0`);
      }
      if (content === "..") {
        root = {};
        stack.push({ level, value: root });
      } else if (content === ":") {
        root = [];
        stack.push({ level, value: root });
      } else {
        // Root is a single string
        root = parseStringValue(content);
      }
      continue;
    }

    if (!parent) {
      throw new Error(`Line ${lineIndex + 1}: Orphaned indentation level`);
    }

    // If parent is a Sequence
    if (Array.isArray(parent.value)) {
      if (content === "..") {
        const child: Mapping = {};
        parent.value.push(child);
        stack.push({ level, value: child });
      } else if (content === ":") {
        const child: Sequence = [];
        parent.value.push(child);
        stack.push({ level, value: child });
      } else if (content === "|") {
        // Sequence item is a multiline string
        stack.push({
          level,
          value: parent.value,
          isMultiline: true,
          multilineHeaderLevel: indentSpaces,
          multilineLines: [],
        });
      } else {
        // Sequence item is a primitive string value
        parent.value.push(parseStringValue(content));
      }
    } 
    // If parent is a Mapping
    else {
      // Find key and construct
      // A key matches [A-Za-z_][A-Za-z0-9_-]*
      const keyMatch = content.match(/^([A-Za-z_][A-Za-z0-9_-]*)(.*)$/);
      if (!keyMatch) {
        throw new Error(`Line ${lineIndex + 1}: Invalid mapping key in "${content}"`);
      }
      const key = keyMatch[1];
      const rest = keyMatch[2].trim();

      if (rest === "..") {
        const child: Mapping = {};
        parent.value[key] = child;
        stack.push({ level, value: child });
      } else if (rest === ":") {
        const child: Sequence = [];
        parent.value[key] = child;
        stack.push({ level, value: child });
      } else if (rest === "|") {
        stack.push({
          level,
          value: parent.value,
          key,
          isMultiline: true,
          multilineHeaderLevel: indentSpaces,
          multilineLines: [],
        });
      } else {
        // Plain key-value pair
        parent.value[key] = parseStringValue(rest);
      }
    }
  }

  // Close any remaining multiline strings on stack
  closeMultilineString(stack);

  return root;
}

function closeMultilineString(stack: any[]) {
  const current = stack[stack.length - 1];
  if (current && current.isMultiline) {
    stack.pop();
    finalizeMultiline(current);
  }
}

function finalizeMultiline(item: any) {
  let text = item.multilineLines.join("\n");
  // Trim optional final trailing blank lines
  text = text.replace(/\n+$/, "");
  
  if (Array.isArray(item.value)) {
    item.value.push(text);
  } else if (item.key) {
    item.value[item.key] = text;
  }
}

function parseStringValue(val: string): string {
  val = val.trim();
  if (val.startsWith('"') && val.endsWith('"')) {
    return unescapeQuotedNanoString(val.slice(1, -1));
  }
  return val;
}

export function stringifyNano(value: unknown): string {
  return serializeValue(value, 0).join("\n");
}

function serializeValue(value: unknown, indentLevel: number): string[] {
  if (Array.isArray(value)) {
    return serializeSequence(value, indentLevel);
  }

  if (isPlainObject(value)) {
    return serializeMapping(value as Mapping, indentLevel);
  }

  if (typeof value === "string") {
    return [formatInlineScalar(value)];
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return [formatInlineScalar(String(value))];
  }

  if (value === null || value === undefined) {
    return [formatInlineScalar("")];
  }

  throw new Error(`Unsupported Nano value type: ${typeof value}`);
}

function serializeSequence(sequence: Sequence, indentLevel: number): string[] {
  const indent = spaces(indentLevel);
  const lines = [`${indent}:`];
  for (const item of sequence) {
    lines.push(...serializeSequenceItem(item, indentLevel + 1));
  }
  return lines;
}

function serializeSequenceItem(value: Value | unknown, indentLevel: number): string[] {
  if (Array.isArray(value)) {
    return serializeSequence(value, indentLevel);
  }

  if (isPlainObject(value)) {
    return serializeMapping(value as Mapping, indentLevel);
  }

  if (typeof value === "string") {
    return serializeScalarOrMultiline(value, indentLevel);
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return [formatInlineScalar(String(value))];
  }

  if (value === null || value === undefined) {
    return [formatInlineScalar("")];
  }

  throw new Error(`Unsupported Nano sequence item type: ${typeof value}`);
}

function serializeMapping(mapping: Mapping, indentLevel: number): string[] {
  const indent = spaces(indentLevel);
  const keys = Object.keys(mapping);
  const lines = [`${indent}..`];
  for (const key of keys) {
    lines.push(...serializeMappingEntry(key, mapping[key], indentLevel + 1));
  }
  return lines;
}

function serializeMappingEntry(key: string, value: Value | unknown, indentLevel: number): string[] {
  if (!isValidNanoKey(key)) {
    throw new Error(`Unsupported Nano key: ${key}`);
  }

  if (value === undefined || value === null) {
    return [];
  }

  const indent = spaces(indentLevel);

  if (Array.isArray(value)) {
    return [`${indent}${key}:`, ...serializeSequenceBody(value, indentLevel + 1)];
  }

  if (isPlainObject(value)) {
    return [`${indent}${key}..`, ...serializeMappingBody(value as Mapping, indentLevel + 1)];
  }

  if (typeof value === "string") {
    if (value.includes("\n")) {
      return [`${indent}${key} |`, ...serializeMultiline(value, indentLevel + 1)];
    }
    return [`${indent}${key} ${formatInlineScalar(value)}`];
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return [`${indent}${key} ${formatInlineScalar(String(value))}`];
  }

  if (value === null || value === undefined) {
    return [`${indent}${key} ${formatInlineScalar("")}`];
  }

  throw new Error(`Unsupported Nano mapping value type: ${typeof value}`);
}

function serializeSequenceBody(sequence: Sequence, indentLevel: number): string[] {
  const lines: string[] = [];
  for (const item of sequence) {
    lines.push(...serializeSequenceItem(item, indentLevel));
  }
  return lines;
}

function serializeMappingBody(mapping: Mapping, indentLevel: number): string[] {
  const lines: string[] = [];
  for (const key of Object.keys(mapping)) {
    lines.push(...serializeMappingEntry(key, mapping[key], indentLevel));
  }
  return lines;
}

function serializeScalarOrMultiline(value: string, indentLevel: number): string[] {
  if (value.includes("\n")) {
    return [`${spaces(indentLevel)}|`, ...serializeMultiline(value, indentLevel + 1)];
  }
  return [`${spaces(indentLevel)}${formatInlineScalar(value)}`];
}

function serializeMultiline(value: string, indentLevel: number): string[] {
  const indent = spaces(indentLevel);
  const lines = value.replace(/\n+$/, "").split("\n");
  return lines.map((line) => `${indent}${line}`);
}

function quoteNanoString(value: string): string {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t");
  return `"${escaped}"`;
}

function formatInlineScalar(value: string): string {
  if (value === "") {
    return quoteNanoString(value);
  }

  if (needsQuotedScalar(value)) {
    return quoteNanoString(value);
  }

  return value;
}

function needsQuotedScalar(value: string): boolean {
  if (/^\s|\s$/.test(value)) {
    return true;
  }

  if (value === ".." || value === ":" || value === "|") {
    return true;
  }

  if (value.startsWith("#")) {
    return true;
  }

  return false;
}

function unescapeQuotedNanoString(value: string): string {
  let result = "";
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (char !== "\\") {
      result += char;
      continue;
    }

    const next = value[++i];
    if (next === undefined) {
      result += "\\";
      break;
    }

    switch (next) {
      case "n":
        result += "\n";
        break;
      case "r":
        result += "\r";
        break;
      case "t":
        result += "\t";
        break;
      case '"':
        result += '"';
        break;
      case "\\":
        result += "\\";
        break;
      default:
        result += next;
        break;
    }
  }

  return result;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidNanoKey(key: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_-]*$/.test(key);
}

function spaces(indentLevel: number): string {
  return " ".repeat(indentLevel * 4);
}
