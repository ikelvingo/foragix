#!/usr/bin/env node
/**
 * Comment-integrity smoke check.
 *
 * After the comment trimming pass, this verifies that the information the trimming rules
 * classified as "must not be lost" is still present, and present in roughly the right place.
 *
 * Scope limits, stated plainly: this is a **text-presence** check. It can tell that a required
 * phrase still occurs in a comment, and it can tell that a whole block was not deleted. It cannot
 * tell that a block was rewritten to mean something weaker. Treat a pass as "no obvious loss",
 * not as proof of semantic equivalence.
 *
 * Comment extraction uses the TypeScript scanner rather than a regex, so a comment-looking
 * sequence inside a string literal is never mistaken for a comment.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

const root = process.cwd();

const read = (p) => {
  try {
    return readFileSync(join(root, p), 'utf8');
  } catch {
    return '';
  }
};

/**
 * All comments in a TS/JS source, taken from the TypeScript AST's comment ranges.
 * Using the parser (not a regex) means a comment-looking sequence inside a string literal is
 * never mistaken for a comment, and end-of-line `//` comments are not missed.
 */
function commentsOf(src) {
  const sf = ts.createSourceFile('probe.ts', src, ts.ScriptTarget.Latest, true);
  const parts = [];
  const seen = new Set();
  const collect = (ranges) => {
    for (const r of ranges ?? []) {
      const key = `${r.pos}:${r.end}`;
      if (seen.has(key)) continue;
      seen.add(key);
      parts.push(src.slice(r.pos, r.end));
    }
  };
  const visit = (node) => {
    collect(ts.getLeadingCommentRanges(src, node.getFullStart()));
    collect(ts.getTrailingCommentRanges(src, node.getEnd()));
    ts.forEachChild(node, visit);
  };
  visit(sf);
  collect(ts.getLeadingCommentRanges(src, sf.endOfFileToken.getFullStart()));
  return parts.join('\n');
}

/** Comments in a SQL source: single-quoted runs are treated as opaque first. */
function sqlCommentsOf(src) {
  let opaque = '';
  let inString = false;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === "'") {
      inString = !inString;
      continue;
    }
    if (!inString) opaque += ch;
  }
  return opaque
    .split('\n')
    .filter((l) => l.trim().startsWith('--'))
    .join('\n');
}

/** The leading comment block attached to a named declaration. */
function docCommentFor(src, symbol) {
  const sf = ts.createSourceFile('probe.ts', src, ts.ScriptTarget.Latest, true);
  let found = null;
  const visit = (node) => {
    if (found !== null) return;
    // Match declarations only: a call site such as `this.applyFailure(...)` also exposes a `name`,
    // and would otherwise overwrite the real declaration's comment with an empty string.
    const isDeclaration =
      ts.isMethodDeclaration(node) ||
      ts.isFunctionDeclaration(node) ||
      ts.isPropertyDeclaration(node) ||
      ts.isVariableStatement(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isClassDeclaration(node);
    if (isDeclaration && node.name?.getText?.(sf) === symbol) {
      const ranges = ts.getLeadingCommentRanges(src, node.getFullStart()) ?? [];
      found = ranges.map((r) => src.slice(r.pos, r.end)).join('\n');
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

function allTsFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(join(root, d), { withFileTypes: true })) {
      const p = `${d}/${e.name}`;
      if (e.isDirectory()) walk(p);
      else if (p.endsWith('.ts')) out.push(p);
    }
  };
  walk(dir);
  return out;
}

/**
 * Each expectation names the file, one or more acceptable needles (any match passes), and
 * optionally the symbol whose doc comment must carry it.
 */
const EXPECTATIONS = [
  // security boundaries: the scope must survive, not just the sentiment
  { file: 'src/engine.ts', symbol: 'applyFailure', any: ['evidence'], why: 'evidence excluded from log and diagnostics' },
  { file: 'src/errors/redact.ts', any: ['best-effort'], why: 'redaction is not a security guarantee' },
  { file: 'src/errors/redact.ts', any: ['allowlist'], why: 'error name allowlist' },
  { file: 'src/errors/redact.ts', any: ['closed set'], why: 'closed set of error codes' },
  { file: 'src/credentials/load.ts', any: ['hash'], why: 'only the credential hash is stored' },

  // state recovery conditions
  { file: 'src/db/bits.ts', any: ['external event'], why: 'QUOTA_UNKNOWN recovers only on an external event' },
  { file: 'src/db/bits.ts', any: ['period boundary'], why: 'a period boundary never clears it' },
  { file: 'src/state/machine.ts', any: ['boundary'], why: 'quota bits clear only at their own boundary' },
  { file: 'src/state/machine.ts', any: ['credential fingerprint'], why: 'rejected bit clears only on fingerprint change' },

  // ambiguous config semantics and units
  { file: 'src/providers/types.ts', any: ['independent'], why: 'quotaPeriod is independent of local limits' },
  { file: 'src/providers/types.ts', any: ['external event'], why: 'meaning of quotaPeriod none' },
  { file: 'sql/schema.sql', any: ['resets on'], why: 'quota_period column documented' },
  { file: 'sql/schema.sql', any: ['hash'], why: 'fingerprint/pool columns store hashes only' },

  // concurrency invariants
  { file: 'src/db/sqlite.ts', symbol: 'transaction', any: ['network'], why: 'no write transaction across a network call' },
  { file: 'src/db/sqlite.ts', any: ['read-modify-write'], why: 'bit updates avoid read-modify-write' },
  { file: 'src/engine.ts', any: ['transaction'], why: 'state events are transactional' },

  // routing contract
  { file: 'src/routing/select.ts', any: ['deterministic'], why: 'selection is deterministic' },
  { file: 'src/routing/select.ts', any: ['priority'], why: 'ordering rule documented' },

  // storage model
  { file: 'src/db/schema.ts', any: ['automatic'], why: 'no automatic migration' },
  { file: 'src/runtime/db.ts', any: ['fingerprint'], why: 'DDL fingerprint validation' },
  { file: 'src/runtime/db.ts', any: ['probe'], why: 'per-column probe' },

  // vendor facts must keep their uncertainty markers
  { file: 'src/providers/tavily/index.ts', any: ['1,000 credits'], why: 'Tavily free quota' },
  { file: 'src/providers/tavily/index.ts', any: ['unverified'], why: 'Tavily unverified reset time' },
  { file: 'src/providers/exa/index.ts', any: ['usd balance'], why: 'Exa quota is a USD balance' },
  { file: 'src/providers/exa/index.ts', any: ['unverified'], why: 'Exa unverified auto-recharge' },

  // product framing
  { file: 'src/index.ts', any: ['llm'], why: 'caller is an LLM, not a human' },
];

let failed = 0;

for (const exp of EXPECTATIONS) {
  const src = read(exp.file);
  if (src === '') {
    console.log(`  FAIL ${exp.file}: file missing (${exp.why})`);
    failed += 1;
    continue;
  }

  const isSql = exp.file.endsWith('.sql');
  let haystack;
  if (exp.symbol !== undefined) {
    if (isSql) {
      console.log(`  FAIL ${exp.file}: symbol checks are not supported for SQL (${exp.why})`);
      failed += 1;
      continue;
    }
    const doc = docCommentFor(src, exp.symbol);
    if (doc === null) {
      console.log(`  FAIL ${exp.file}: no declaration named \`${exp.symbol}\` (${exp.why})`);
      failed += 1;
      continue;
    }
    haystack = doc;
  } else {
    haystack = isSql ? sqlCommentsOf(src) : commentsOf(src);
  }
  haystack = haystack.toLowerCase();

  if (!exp.any.some((n) => haystack.includes(n.toLowerCase()))) {
    const where = exp.symbol === undefined ? exp.file : `${exp.file} (doc of ${exp.symbol})`;
    console.log(`  FAIL ${where}: missing ${exp.any.map((n) => `"${n}"`).join(' or ')} — ${exp.why}`);
    failed += 1;
  }
}

/** Every NOT_IMPLEMENTED entry must keep a substantive reason. */
const registry = read('src/providers/registry.ts');
const entries = [...registry.matchAll(/\{\s*id:\s*'([^']+)',\s*reason:\s*'([^']*)'/g)];
if (entries.length < 10) {
  console.log(`  FAIL registry: only ${entries.length} NOT_IMPLEMENTED reasons, expected >= 10`);
  failed += 1;
}
for (const [, id, reason] of entries) {
  if ((reason ?? '').trim().length < 20) {
    console.log(`  FAIL registry: reason for \`${id}\` looks like a placeholder`);
    failed += 1;
  }
}

/** The CJK regexes are executable logic; they must not be "translated" away. */
const classify = read('src/errors/classify.ts');
for (const re of ['额度', '余额', '配额', '密钥', '凭证']) {
  if (!classify.includes(re)) {
    console.log(`  FAIL classify: CJK regex /${re}/ was removed (executable logic, not prose)`);
    failed += 1;
  }
}

/** No design-document pointers may remain in comments. */
const DESIGN_POINTER = /design basis|documents\//i;
const commentTargets = [
  ...allTsFiles('src'),
  'sql/schema.sql',
  'bin/foragix.mjs',
];
for (const rel of commentTargets) {
  const text = rel.endsWith('.sql') ? sqlCommentsOf(read(rel)) : commentsOf(read(rel));
  if (DESIGN_POINTER.test(text)) {
    console.log(`  FAIL ${rel}: still points at an out-of-repo design document`);
    failed += 1;
  }
}

console.log(failed === 0 ? '\n  OK: no obvious loss of required comment content' : `\n  FAIL: ${failed} check(s)`);
process.exit(failed === 0 ? 0 : 1);
