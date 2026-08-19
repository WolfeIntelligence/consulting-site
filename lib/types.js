/* Property types.
 *
 * A superset of the field vocabulary the console already uses, so the existing
 * intakes migrate without losing anything. os.js writes a field as
 * `[key, label, 'select:a=A|b=B', hint]`; that string form is parsed here
 * rather than reinvented, and everything it can say, this can say.
 *
 * `ref` and `refs` are the important ones. A set of forms becomes an ontology
 * at the moment one record can point at another and the system knows what the
 * pointer means.
 *
 * Every type answers the same four questions: how a raw value becomes a stored
 * value (coerce), whether the stored value is acceptable (validate), how it
 * reads to a person (format), and whether it is empty. Keeping those together
 * is what lets the screen, the API and the action framework agree on what a
 * value means instead of each one guessing separately.
 */

const TYPES = {
  text:        { store: 'string' },
  textarea:    { store: 'string', long: true },
  markdown:    { store: 'string', long: true },
  select:      { store: 'string', options: true },
  multiselect: { store: 'array', options: true },
  number:      { store: 'number' },
  money:       { store: 'number' },
  percent:     { store: 'number' },
  bool:        { store: 'bool' },
  date:        { store: 'string' },
  datetime:    { store: 'string' },
  email:       { store: 'string' },
  phone:       { store: 'string' },
  url:         { store: 'string' },
  ref:         { store: 'string', ref: true },
  refs:        { store: 'array', ref: true },
  file:        { store: 'string', file: true },
  files:       { store: 'array', file: true },
};

const isType = (t) => Object.prototype.hasOwnProperty.call(TYPES, t);

/* The console's inline option syntax, e.g. `select:|yes=Verified|no=Not yet`.
 * An empty key is the "not answered yet" choice and is kept, because the
 * routing logic distinguishes "no" from "never asked". */
function parseInline(spec) {
  const s = String(spec || '');
  const i = s.indexOf(':');
  if (i < 0) return { type: s, options: null };
  const options = s.slice(i + 1).split('|').filter(function (p) { return p !== ''; }).map(function (p) {
    const j = p.indexOf('=');
    return j < 0 ? { value: p, label: p } : { value: p.slice(0, j), label: p.slice(j + 1) };
  });
  return { type: s.slice(0, i), options: options };
}

/* Normalise either shape a property may be written in - the console's
 * four-element array, or a full object - into one object. */
function property(def) {
  if (Array.isArray(def)) {
    const parsed = parseInline(def[2]);
    return {
      key: def[0],
      label: def[1],
      type: isType(parsed.type) ? parsed.type : 'text',
      hint: def[3] || '',
      options: parsed.options,
    };
  }
  const p = Object.assign({}, def);
  if (typeof p.type === 'string' && p.type.indexOf(':') >= 0) {
    const parsed = parseInline(p.type);
    p.type = parsed.type;
    if (!p.options) p.options = parsed.options;
  }
  if (!isType(p.type)) p.type = 'text';
  return p;
}

function trimTo(v, n) {
  return String(v == null ? '' : v).trim().slice(0, n);
}

function coerce(prop, raw) {
  const t = TYPES[prop.type] || TYPES.text;
  if (raw == null) return t.store === 'array' ? [] : null;
  switch (prop.type) {
    case 'number':
    case 'money':
    case 'percent': {
      if (raw === '') return null;
      const n = typeof raw === 'number' ? raw : parseFloat(String(raw).replace(/[^0-9.eE+-]/g, ''));
      return Number.isFinite(n) ? n : null;
    }
    case 'bool':
      if (typeof raw === 'boolean') return raw;
      return ['yes', 'true', '1', 'on'].indexOf(String(raw).trim().toLowerCase()) >= 0;
    case 'date': {
      const s = trimTo(raw, 40);
      if (!s) return null;
      const d = new Date(s);
      return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
    }
    case 'datetime': {
      const s = trimTo(raw, 40);
      if (!s) return null;
      const d = new Date(s);
      return isNaN(d.getTime()) ? null : d.toISOString();
    }
    case 'email': return trimTo(raw, 200).toLowerCase();
    case 'multiselect':
    case 'refs':
    case 'files':
      return (Array.isArray(raw) ? raw : String(raw).split(',')).map(function (v) { return trimTo(v, 200); }).filter(Boolean);
    case 'textarea':
    case 'markdown': return trimTo(raw, 8000);
    default: return trimTo(raw, 500);
  }
}

function isEmpty(prop, value) {
  const t = TYPES[prop.type] || TYPES.text;
  if (value == null) return true;
  if (t.store === 'array') return !Array.isArray(value) || value.length === 0;
  if (t.store === 'bool') return false;          // false is an answer, not a blank
  if (t.store === 'number') return !Number.isFinite(value);
  return String(value) === '';
}

/* Returns an error string, or '' when the value is acceptable. Lenient about
 * formatting and strict about the two things that actually break something
 * downstream: a required answer that is missing, and a choice that is not one
 * of the offered choices. */
function validate(prop, value) {
  if (isEmpty(prop, value)) return prop.required ? (prop.label || prop.key) + ' is required' : '';
  if (prop.type === 'select' && prop.options && prop.options.length) {
    if (!prop.options.some(function (o) { return o.value === value; })) {
      return 'Not one of the choices for ' + (prop.label || prop.key);
    }
  }
  if (prop.type === 'multiselect' && prop.options && prop.options.length) {
    const allowed = prop.options.map(function (o) { return o.value; });
    for (const v of value) if (allowed.indexOf(v) < 0) return 'Not one of the choices for ' + (prop.label || prop.key);
  }
  if (prop.type === 'email' && !/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(value)) return 'That does not look like an email address';
  if (prop.type === 'url' && !/^https?:\/\/\S+$/.test(value)) return 'A web address must start with http:// or https://';
  if ((prop.type === 'number' || prop.type === 'money' || prop.type === 'percent') && typeof value !== 'number') {
    return (prop.label || prop.key) + ' must be a number';
  }
  return '';
}

const DASH = '—';

function money(n) {
  return Number.isFinite(n) ? '$' + Math.round(n).toLocaleString('en-US') : DASH;
}

function format(prop, value) {
  if (isEmpty(prop, value)) return DASH;
  switch (prop.type) {
    case 'money': return money(value);
    case 'percent': return Math.round(value * 10) / 10 + '%';
    case 'number': return Number(value).toLocaleString('en-US');
    case 'bool': return value ? 'Yes' : 'No';
    case 'datetime': return String(value).replace('T', ' ').slice(0, 16);
    case 'select': {
      const o = (prop.options || []).find(function (x) { return x.value === value; });
      return o ? o.label : String(value);
    }
    case 'multiselect': {
      const by = {};
      for (const o of prop.options || []) by[o.value] = o.label;
      return value.map(function (v) { return by[v] || v; }).join(', ');
    }
    case 'refs':
    case 'files': return value.length + (value.length === 1 ? ' item' : ' items');
    default: return String(value);
  }
}

module.exports = { TYPES, isType, parseInline, property, coerce, validate, isEmpty, format, money };
