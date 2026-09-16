// Parser for OpenSCAD's `.csg` dump (post-parse, pre-boolean node tree).
// Produced by `openscad -o out.csg` from openscad-wasm-prebuilt; see
// ../PHASES.md.
//
// GPL-2.0-or-later; part of the OpenSCAD fast-preview module. The renderer
// in this module is ported from OpenCSG (© Florian Kirsch, HPI).
//
// Grammar (whitespace-insensitive):
//
//   file    := node EOF
//   node    := IDENT '(' params? ')' (';' | '{' node* '}')
//   params  := param (',' param)*
//   param   := (IDENT '=')? value
//   value   := STRING | NUMBER | 'true' | 'false' | 'undefined'
//            | vector | range
//   vector  := '[' (value (',' value)*)? ']'
//   range   := '[' value ':' value (':' value)? ']'
//
// Range vs vector is disambiguated after parsing the first element.
// Strings honor backslash escapes; `}`/`;`/`,` etc. inside them are literal.
//
// Output node shape:
//   { type, params: [{key, value}], named: {key: value}, children: [] }

export function parseCsg(text) {
  const toks = tokenize(text);
  let pos = 0;
  const peek = () => toks[pos];
  const next = () => toks[pos++];

  function expect(kind, val) {
    const t = toks[pos];
    if (!t || t.kind !== kind || (val !== undefined && t.val !== val)) {
      throw new Error(`csg-parser: expected ${kind}${val ? ' ' + JSON.stringify(val) : ''} at token ${pos} (${JSON.stringify(t)}), line ${t ? t.line : '?'}`);
    }
    return next();
  }

  function parseFile() {
    // The dump may contain several top-level nodes (e.g. multiple root groups);
    // wrap them in a synthetic root.
    const nodes = [];
    for (;;) {
      skipWs();
      if (!peek()) break;
      nodes.push(parseNode());
    }
    if (nodes.length === 0) throw new Error('csg-parser: empty document');
    if (nodes.length === 1) return nodes[0];
    return { type: 'group', params: [], named: {}, children: nodes };
  }

  function parseNode() {
    skipWs();
    const name = expect('ident').val;
    skipWs();
    expect('punct', '(');
    const params = [];
    skipWs();
    if (!check('punct', ')')) {
      do {
        params.push(parseParam());
        skipWs();
        if (check('punct', ',')) { next(); skipWs(); }
      } while (!check('punct', ')'));
    }
    expect('punct', ')');
    skipWs();

    const children = [];
    if (check('punct', '{')) {
      next();
      for (;;) {
        skipWs();
        if (check('punct', '}')) { next(); break; }
        children.push(parseNode());
      }
    } else {
      expect('punct', ';');
    }

    const named = {};
    for (const p of params) if (p.key !== undefined) named[p.key] = p.value;
    return { type: name, params, named, children };
  }

  function parseParam() {
    skipWs();
    // lookahead: IDENT '=' → keyed param; otherwise positional value
    if (peek() && peek().kind === 'ident' && toks[pos + 1] &&
        toks[pos + 1].kind === 'punct' && toks[pos + 1].val === '=') {
      const key = next().val;
      next(); // '='
      return { key, value: parseValue() };
    }
    return { value: parseValue() };
  }

  function skipWs() {
    while (peek() && peek().kind === 'ws') next();
  }
  function check(kind, val) {
    const t = peek();
    return !!t && t.kind === kind && (val === undefined || t.val === val);
  }

  function parseValue() {
    skipWs();
    const t = peek();
    if (!t) throw new Error('csg-parser: unexpected EOF in value');
    if (t.kind === 'string') { next(); return t.val; }
    if (t.kind === 'number') { next(); return t.val; }
    if (t.kind === 'punct' && t.val === '-') {
      next();
      const n = expect('number').val;
      return -n;
    }
    if (t.kind === 'punct' && t.val === '[') {
      return parseVectorOrRange();
    }
    if (t.kind === 'ident') {
      if (t.val === 'true') { next(); return true; }
      if (t.val === 'false') { next(); return false; }
      if (t.val === 'undefined') { next(); return undefined; }
      throw new Error(`csg-parser: unexpected identifier value ${t.val}`);
    }
    throw new Error(`csg-parser: unexpected token ${JSON.stringify(t)} in value`);
  }

  function parseVectorOrRange() {
    expect('punct', '[');
    const items = [];
    let colons = 0;
    skipWs();
    if (!check('punct', ']')) {
      for (;;) {
        items.push(parseValue());
        skipWs();
        if (check('punct', ',')) { next(); skipWs(); continue; }
        if (check('punct', ':')) { next(); colons++; skipWs(); continue; }
        break;
      }
    }
    expect('punct', ']');
    if (colons === 0) return items;
    if (colons === 1) return { range: true, start: items[0], step: 1, end: items[1] };
    return { range: true, start: items[0], step: items[1], end: items[2] };
  }

  return parseFile();
}

function tokenize(text) {
  const toks = [];
  const n = text.length;
  let i = 0, line = 1;
  const NUM = /(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;
  const IDENT = /[A-Za-z_$][A-Za-z0-9_$]*/y;
  while (i < n) {
    const c = text[i];
    if (c === '\n') { line++; i++; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
    if (c === '"') {
      let j = i + 1, s = '';
      while (j < n && text[j] !== '"') {
        if (text[j] === '\\' && j + 1 < n) {
          const e = text[j + 1];
          s += e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '\r' : e;
          j += 2;
        } else s += text[j++];
      }
      if (j >= n) throw new Error(`csg-parser: unterminated string at line ${line}`);
      toks.push({ kind: 'string', val: s, line });
      i = j + 1;
      continue;
    }
    if (c === '-') {
      if (!peekIsNum(text, i + 1)) { toks.push({ kind: 'punct', val: '-', line }); i++; continue; }
      NUM.lastIndex = i + 1;
      const m = NUM.exec(text);
      if (!m) throw new Error(`csg-parser: bad number at line ${line}: ${text.slice(i, i + 12)}`);
      toks.push({ kind: 'number', val: -parseFloat(m[0]), line });
      i = NUM.lastIndex;
      continue;
    }
    if ((c >= '0' && c <= '9') || c === '.') {
      NUM.lastIndex = i;
      const m = NUM.exec(text);
      if (!m) throw new Error(`csg-parser: bad number at line ${line}: ${text.slice(i, i + 12)}`);
      toks.push({ kind: 'number', val: parseFloat(m[0]), line });
      i = NUM.lastIndex;
      continue;
    }
    IDENT.lastIndex = i;
    const im = IDENT.exec(text);
    if (im && im.index === i) {
      toks.push({ kind: 'ident', val: im[0], line });
      i = IDENT.lastIndex;
      continue;
    }
    if ('{}[](),:;='.includes(c)) {
      toks.push({ kind: 'punct', val: c, line });
      i++;
      continue;
    }
    throw new Error(`csg-parser: unexpected character ${JSON.stringify(c)} at line ${line}`);
  }
  return toks;
}

// a '-' followed by a digit/dot is a number sign, not the minus punct
function peekIsNum(text, i) {
  const c = text[i];
  return (c >= '0' && c <= '9') || c === '.';
}
