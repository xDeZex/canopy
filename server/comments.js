import { parseDocument, visit } from 'yaml';

const CORE_TAGS = new Set(['str', 'int', 'float', 'bool', 'null', 'map', 'seq']
  .map((name) => `tag:yaml.org,2002:${name}`));
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const string = (value) => typeof value === 'string' && value.length > 0;
function timestamp(value) {
  if (!string(value) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) ||
      !Number.isFinite(Date.parse(value))) return false;
  // Date.parse normalizes February 30 instead of rejecting it.
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= days[month - 1] && Number(value.slice(11, 13)) < 24;
}
const hasExactKeys = (value, expected) => record(value) && Object.keys(value).length === expected.length &&
  expected.every((key) => Object.hasOwn(value, key));
const uniqueIds = (values) => new Set(values.map((value) => value.id)).size === values.length;

export function validAnchorPath(file) {
  return string(file) && !/[:\\\x00-\x1f\x7f]/.test(file) &&
    file.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

function validThread(thread) {
  const common = ['id', 'created_at', 'resolved', 'messages'];
  const general = hasExactKeys(thread, common);
  const anchored = hasExactKeys(thread, [...common, 'file', 'side', 'line_range']) &&
    validAnchorPath(thread.file) && thread.side === 'modified' &&
    hasExactKeys(thread.line_range, ['start', 'end']) && Number.isSafeInteger(thread.line_range.start) &&
    Number.isSafeInteger(thread.line_range.end) && thread.line_range.start >= 1 &&
    thread.line_range.end >= thread.line_range.start;
  return (general || anchored) && string(thread.id) && timestamp(thread.created_at) &&
    typeof thread.resolved === 'boolean' && Array.isArray(thread.messages) && thread.messages.length > 0 &&
    thread.messages.every((message) => hasExactKeys(message, ['id', 'author', 'text', 'created_at']) &&
      string(message.id) && ['user', 'agent'].includes(message.author) &&
      typeof message.text === 'string' && timestamp(message.created_at)) && uniqueIds(thread.messages);
}

export function parseComments(source) {
  try {
    const doc = parseDocument(source, { schema: 'core', resolveKnownTags: false });
    if (doc.errors.length || doc.warnings.length) throw new Error('Malformed YAML or unsupported tag');
    visit(doc, (_key, node) => {
      if (node?.tag && !CORE_TAGS.has(node.tag)) throw new Error('Unsupported YAML tag');
    });
    const data = doc.toJS({ maxAliasCount: 100 });
    if (!hasExactKeys(data, ['version', 'threads']) || data.version !== 1 || !Array.isArray(data.threads) ||
        !data.threads.every(validThread) || !uniqueIds(data.threads)) throw new Error('Invalid version 1 schema');
    return { warning: null, threads: data.threads.map((thread) => ({ ...thread,
      messages: [...thread.messages].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at)),
    })).sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at)) };
  } catch (err) {
    return { threads: [], warning: `Cannot load comments: ${err.message}` };
  }
}
