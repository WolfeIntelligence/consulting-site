/* The metamodel: what a workspace's object types, links, rules and actions are.
 *
 * os.js carries three complete copies of one idea — a phase list, a field list,
 * routing logic, blocker rules and a packet template, written out once for
 * Google engagements, once for private AI and once for automation. A fourth
 * engagement type means a fourth copy, and the copies have already drifted.
 * This file is the fix: the shape of a client's business is a record, not code.
 *
 * Three rules govern it, all learned the hard way in Wolfe OS:
 *
 *   1. Validation returns violations, it does not throw. One bad link must not
 *      take a whole workspace offline — it is reported and left out of the
 *      index, and everything else keeps working.
 *   2. The rule registry is closed. A free-text condition would let someone
 *      write a rule that quietly does nothing, and they would never find out.
 *   3. Checks are compiled at save time with their wording frozen. Renaming a
 *      property later must not silently change what a refusal says happened.
 */

const { property, isType, isEmpty } = require('./types');
const { digest } = require('./digest');

const SCHEMA_VERSION = 1;

/* ------------------------------------------------------------------ links */

/* A link is a typed, named edge with an inverse. Cardinality is declared on
 * the near side: 'one' means this object points at a single target ("this lead
 * belongs to one client"), 'many' means a set. The inverse is required, not
 * optional, because a graph you can only walk in one direction is a set of
 * forms with pointers, not an ontology. */
const CARDINALITIES = ['one', 'many'];

/* ---------------------------------------------------------- rule registry */

/* Closed on purpose. An application can only enforce a rule it knows how to
 * evaluate. `passes` receives the object's own properties, so a rule never
 * reaches outside the record it is judging. */
const RULES = {
  'must-be-filled': {
    appliesTo: null,                    // any type
    needsThreshold: false,
    label: (p) => p.label + ' must be filled in',
    requirement: (p) => p.label + ' must be filled in.',
    passes: (props, p) => !isEmpty(p, props[p.key]),
  },
  'number-at-least': {
    appliesTo: ['number', 'money', 'percent'],
    needsThreshold: true,
    label: (p, t) => p.label + ' is at least ' + t,
    requirement: (p, t) => p.label + ' must be at least ' + t + '.',
    passes: (props, p, t) => Number.isFinite(props[p.key]) && props[p.key] >= t,
  },
  'number-at-most': {
    appliesTo: ['number', 'money', 'percent'],
    needsThreshold: true,
    label: (p, t) => p.label + ' is at most ' + t,
    requirement: (p, t) => p.label + ' must be at most ' + t + '.',
    passes: (props, p, t) => Number.isFinite(props[p.key]) && props[p.key] <= t,
  },
  'number-below-field': {
    appliesTo: ['number', 'money', 'percent'],
    needsThreshold: false,
    needsOther: true,
    label: (p, t, o) => p.label + ' is below ' + (o ? o.label : 'another number'),
    requirement: (p, t, o) => p.label + ' must be below ' + (o ? o.label : 'the other number') + '.',
    passes: (props, p, t, o) => o && Number.isFinite(props[p.key]) && Number.isFinite(props[o.key]) && props[p.key] < props[o.key],
  },
  'is-one-of': {
    appliesTo: ['select', 'text'],
    needsThreshold: false,
    needsChoices: true,
    label: (p, t, o, c) => p.label + ' is ' + (c || []).join(' or '),
    requirement: (p, t, o, c) => p.label + ' must be ' + (c || []).join(' or ') + '.',
    passes: (props, p, t, o, c) => (c || []).indexOf(props[p.key]) >= 0,
  },
  'date-is-set': {
    appliesTo: ['date', 'datetime'],
    needsThreshold: false,
    label: (p) => p.label + ' has a date',
    requirement: (p) => p.label + ' needs a date.',
    passes: (props, p) => !isEmpty(p, props[p.key]),
  },
};
const RULE_IDS = Object.keys(RULES);

/* --------------------------------------------------------------- actions */

/* An action is data, not a function. It declares what it sets, what it stamps
 * with the current time, and what it costs in authority. Keeping effects
 * declarative is what lets the same definition drive a button, an API call, an
 * audit entry and a permission check without any of them re-deciding.
 *
 * `effect` and `risk` come from Wolfe OS's command declarations; `requiresOwner`
 * is its `requiresOwnerPress` — the flag that says a client may ask for this
 * but only the operator completes it. */
const EFFECTS = ['read', 'mutate', 'create', 'archive'];
const RISKS = ['read-only', 'low', 'medium', 'high'];

/* ------------------------------------------------------------ validation */

/* Structured violations, never thrown. Each names what is wrong in words the
 * operator can act on. */
function validateSchema(schema) {
  const v = [];
  const types = (schema && schema.types) || {};
  const typeKeys = Object.keys(types);
  if (!typeKeys.length) v.push({ code: 'no-types', message: 'This workspace has no object types yet.' });

  for (const tk of typeKeys) {
    const t = types[tk];
    if (!t.label) v.push({ code: 'type-unlabelled', type: tk, message: 'Type "' + tk + '" has no name.' });
    const props = (t.properties || []).map(property);
    const seen = new Set();
    for (const p of props) {
      if (!p.key) v.push({ code: 'property-unkeyed', type: tk, message: 'A property on ' + tk + ' has no key.' });
      else if (seen.has(p.key)) v.push({ code: 'property-duplicate', type: tk, property: p.key, message: tk + ' declares "' + p.key + '" twice.' });
      seen.add(p.key);
      if (!isType(p.type)) v.push({ code: 'property-unknown-type', type: tk, property: p.key, message: p.key + ' has an unknown type.' });
    }
    if (t.titleProp && !seen.has(t.titleProp)) {
      v.push({ code: 'title-missing', type: tk, message: tk + ' names "' + t.titleProp + '" as its title, but has no such property.' });
    }

    const linkKeys = new Set();
    for (const l of t.links || []) {
      if (!l.key) { v.push({ code: 'link-unkeyed', type: tk, message: 'A link on ' + tk + ' has no key.' }); continue; }
      if (linkKeys.has(l.key)) v.push({ code: 'link-duplicate', type: tk, link: l.key, message: tk + ' declares link "' + l.key + '" twice.' });
      linkKeys.add(l.key);
      if (!types[l.to]) {
        v.push({ code: 'link-dangling', type: tk, link: l.key, message: tk + '.' + l.key + ' points at "' + l.to + '", which is not a type here.' });
        continue;
      }
      if (CARDINALITIES.indexOf(l.cardinality) < 0) {
        v.push({ code: 'link-cardinality', type: tk, link: l.key, message: tk + '.' + l.key + ' must be one or many.' });
      }
      if (!l.inverse) {
        v.push({ code: 'link-no-inverse', type: tk, link: l.key, message: tk + '.' + l.key + ' has no name for the other direction.' });
      }
    }

    for (const a of t.actions || []) {
      if (!a.key) { v.push({ code: 'action-unkeyed', type: tk, message: 'An action on ' + tk + ' has no key.' }); continue; }
      if (EFFECTS.indexOf(a.effect) < 0) v.push({ code: 'action-effect', type: tk, action: a.key, message: a.key + ' has no valid effect.' });
      if (RISKS.indexOf(a.risk) < 0) v.push({ code: 'action-risk', type: tk, action: a.key, message: a.key + ' has no valid risk level.' });
      for (const k of Object.keys(a.sets || {})) {
        if (!seen.has(k)) v.push({ code: 'action-sets-unknown', type: tk, action: a.key, message: a.key + ' sets "' + k + '", which ' + tk + ' does not have.' });
      }
      for (const k of a.stamps || []) {
        if (!seen.has(k)) v.push({ code: 'action-stamps-unknown', type: tk, action: a.key, message: a.key + ' stamps "' + k + '", which ' + tk + ' does not have.' });
      }
    }

    for (const r of t.rules || []) {
      const def = RULES[r.id];
      if (!def) { v.push({ code: 'rule-unknown', type: tk, message: 'Rule "' + r.id + '" is not one this system can evaluate.' }); continue; }
      const p = props.find((x) => x.key === r.property);
      if (!p) { v.push({ code: 'rule-no-property', type: tk, message: 'A rule on ' + tk + ' points at "' + r.property + '", which no longer exists.' }); continue; }
      if (def.appliesTo && def.appliesTo.indexOf(p.type) < 0) {
        v.push({ code: 'rule-wrong-kind', type: tk, message: '"' + def.label(p, r.threshold) + '" cannot judge a ' + p.type + ' property.' });
      }
      if (def.needsThreshold && !Number.isFinite(r.threshold)) {
        v.push({ code: 'rule-no-threshold', type: tk, message: 'A rule on ' + p.label + ' needs a number to compare against.' });
      }
      if (!def.needsThreshold && Number.isFinite(r.threshold)) {
        v.push({ code: 'rule-extra-threshold', type: tk, message: 'A rule on ' + p.label + ' was given a number it does not use.' });
      }
      if (def.needsOther) {
        const o = props.find((x) => x.key === r.otherProperty);
        if (!o) v.push({ code: 'rule-no-other', type: tk, message: 'A rule on ' + p.label + ' compares against a property that is missing.' });
        else if (o.key === p.key) v.push({ code: 'rule-self-compare', type: tk, message: p.label + ' is compared with itself, so it would never refuse anything.' });
      }
      if (def.needsChoices && !(r.choices && r.choices.length)) {
        v.push({ code: 'rule-no-choices', type: tk, message: 'A rule on ' + p.label + ' lists no acceptable values.' });
      }
    }
  }
  return v;
}

/* ------------------------------------------------------------- compiling */

/* Compile the rules into self-contained checks with their wording already
 * rendered. The write path never reads the schema again, so renaming a
 * property tomorrow cannot change what yesterday's refusal claimed. */
function compileChecks(schema) {
  const out = {};
  const types = (schema && schema.types) || {};
  const bad = new Set(validateSchema(schema).filter((x) => String(x.code).startsWith('rule-')).map((x) => x.type + '|' + x.message));
  for (const tk of Object.keys(types)) {
    const t = types[tk];
    const props = (t.properties || []).map(property);
    const checks = [];
    for (const r of t.rules || []) {
      const def = RULES[r.id];
      const p = props.find((x) => x.key === r.property);
      if (!def || !p) continue;                       // reported by validateSchema; not compiled
      const o = def.needsOther ? props.find((x) => x.key === r.otherProperty) : null;
      if (def.needsOther && !o) continue;
      if (def.needsThreshold && !Number.isFinite(r.threshold)) continue;
      if (def.needsChoices && !(r.choices && r.choices.length)) continue;
      checks.push({
        id: r.id + ':' + r.property,
        ruleId: r.id,
        property: p.key,
        propertyLabel: p.label,                        // frozen at compile time, on purpose
        otherProperty: o ? o.key : '',
        otherLabel: o ? o.label : '',
        threshold: Number.isFinite(r.threshold) ? r.threshold : null,
        choices: r.choices || null,
        requirement: def.requirement(p, r.threshold, o, r.choices),
        blocks: r.blocks || 'save',                    // 'save' refuses the write; 'warn' does not
      });
    }
    out[tk] = checks;
  }
  void bad;
  return out;
}

/* The first failure, not all of them. Someone is fixing one field at a time,
 * and a wall of refusals reads as a broken system rather than a rule tripped. */
function firstRefusal(checks, props, propsByKey) {
  for (const c of checks || []) {
    if (c.blocks !== 'save') continue;
    const def = RULES[c.ruleId];
    // A stored rule this build cannot read refuses rather than passes. Passing
    // would silently drop a rule the client believes is protecting them.
    if (!def) {
      return { check: c, message: '"' + c.requirement + '" is a check this system cannot read, so it will not accept the change.' };
    }
    const p = propsByKey[c.property] || { key: c.property, label: c.propertyLabel, type: 'text' };
    const o = c.otherProperty ? (propsByKey[c.otherProperty] || { key: c.otherProperty, label: c.otherLabel, type: 'number' }) : null;
    if (!def.passes(props, p, c.threshold, o, c.choices)) return { check: c, message: c.requirement };
  }
  return null;
}

/* A schema's identity. Used to tell a stale compiled check from a current one
 * and to know whether a saved view still matches the shape it was built for. */
function revisionOf(schema) {
  return digest({ v: SCHEMA_VERSION, types: (schema && schema.types) || {} });
}

/* What the system says about itself, as data. A screen renders this rather
 * than repeating the list, so the two cannot drift apart. */
function describe() {
  return {
    schemaVersion: SCHEMA_VERSION,
    propertyTypes: Object.keys(require('./types').TYPES),
    cardinalities: CARDINALITIES,
    effects: EFFECTS,
    risks: RISKS,
    rules: RULE_IDS.map((id) => ({
      id,
      appliesTo: RULES[id].appliesTo,
      needsThreshold: !!RULES[id].needsThreshold,
      needsOther: !!RULES[id].needsOther,
      needsChoices: !!RULES[id].needsChoices,
    })),
  };
}

module.exports = {
  SCHEMA_VERSION, CARDINALITIES, RULES, RULE_IDS, EFFECTS, RISKS,
  validateSchema, compileChecks, firstRefusal, revisionOf, describe,
};
