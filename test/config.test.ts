import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig, effectiveAllowPaid } from '../src/config/load.js';
import { ConfigError, type SchemaLookup, type ProviderSchema } from '../src/config/types.js';

const anysearch: ProviderSchema = {
  id: 'anysearch',
  requiresCredentials: true,
  credentialNames: ['ANYSEARCH_API_KEY'],
  accountOptions: {
    developer: { type: 'boolean', description: 'Whether the account is on the developer tier', default: false },
  },
};

const searxng: ProviderSchema = {
  id: 'searxng',
  credentialNames: [],
  accountOptions: {},
};

const lookup: SchemaLookup = {
  get(id) {
    if (id === 'anysearch') return anysearch;
    if (id === 'searxng') return searxng;
    return undefined;
  },
  knownIds: () => ['anysearch', 'searxng'],
};

const VALID = `
version: 1
providers:
  - id: anysearch
    enabled: true
    priority: 10
    credentials:
      - name: ANYSEARCH_API_KEY
        required: true
    account:
      developer: true
  - id: searxng
    enabled: true
    priority: 30
    credentials: []
    account: {}
`;

function issuesOf(text: string) {
  try {
    parseConfig(text, { lookup });
    return null;
  } catch (err) {
    assert.ok(err instanceof ConfigError, `should throw a ConfigError, but got ${String(err)}`);
    return err.issues;
  }
}

test('a valid configuration can be parsed', () => {
  const config = parseConfig(VALID, { lookup });
  assert.equal(config.version, 1);
  assert.equal(config.allowPaid, false, 'the top-level allow_paid defaults to false');
  assert.equal(config.providers.length, 2);
  const first = config.providers[0];
  assert.ok(first);
  assert.equal(first.id, 'anysearch');
  assert.equal(first.enabled, true);
  assert.equal(first.priority, 10);
  assert.deepEqual(first.account, { developer: true });
  assert.equal(first.allowPaid, null, 'it should be null when there is no override');
});

test('the top-level allow_paid defaults to false — paid calls are not accepted by default', () => {
  const config = parseConfig(VALID, { lookup });
  assert.equal(config.allowPaid, false);
});

test('a provider-level allow_paid overrides the top level', () => {
  const config = parseConfig(
    `
version: 1
allow_paid: false
providers:
  - id: searxng
    enabled: true
    priority: 1
    credentials: []
    allow_paid: true
`,
    { lookup },
  );
  const p = config.providers[0];
  assert.ok(p);
  assert.equal(effectiveAllowPaid(config, p), true);
});

test('an unknown top-level key is a startup-level error, and gets a spelling suggestion', () => {
  const issues = issuesOf(`
version: 1
provider:
  - id: searxng
`);
  assert.ok(issues);
  const issue = issues.find((i) => i.path === 'provider');
  assert.ok(issue, 'the unknown top-level key provider must be reported');
  assert.equal(issue.level, 'startup');
  assert.match(issue.message, /providers/, 'it should suggest providers');
});

test('an unsupported version is a startup-level error', () => {
  const issues = issuesOf(`
version: 99
providers:
  - id: searxng
    enabled: true
    priority: 1
    credentials: []
`);
  assert.ok(issues);
  const issue = issues.find((i) => i.path === 'version');
  assert.ok(issue);
  assert.equal(issue.level, 'startup');
  assert.match(issue.message, /99/);
});

test('a duplicate provider id is a startup-level error', () => {
  const issues = issuesOf(`
version: 1
providers:
  - id: searxng
    enabled: true
    priority: 1
    credentials: []
  - id: searxng
    enabled: true
    priority: 2
    credentials: []
`);
  assert.ok(issues);
  const issue = issues.find((i) => i.path === 'providers[1].id');
  assert.ok(issue);
  assert.equal(issue.level, 'startup');
  assert.match(issue.message, /Duplicate/);
});

test('an id with no matching adapter is a provider-level error', () => {
  const issues = issuesOf(`
version: 1
providers:
  - id: anysearchh
    enabled: true
    priority: 1
    credentials:
      - name: X
        required: true
`);
  assert.ok(issues);
  const issue = issues.find((i) => i.path === 'providers[0].id');
  assert.ok(issue);
  assert.equal(issue.level, 'provider');
  assert.match(issue.message, /anysearch/, 'it should suggest anysearch');
});

test('an undeclared key in account is a provider-level error, and gets a spelling suggestion', () => {
  const issues = issuesOf(`
version: 1
providers:
  - id: anysearch
    enabled: true
    priority: 1
    credentials:
      - name: ANYSEARCH_API_KEY
        required: true
    account:
      isDeveloper: true
`);
  assert.ok(issues);
  const issue = issues.find((i) => i.path.includes('isDeveloper'));
  assert.ok(issue, 'the isDevelop key must be reported');
  assert.equal(issue.level, 'provider');
  assert.match(issue.message, /developer/, 'it should suggest developer');
});

test('when the adapter declares no options at all, every account key is rejected', () => {
  const issues = issuesOf(`
version: 1
providers:
  - id: searxng
    enabled: true
    priority: 1
    credentials: []
    account:
      developer: true
`);
  assert.ok(issues);
  const issue = issues.find((i) => i.path.includes('developer'));
  assert.ok(issue);
  assert.match(issue.message, /declares no account options at all/);
});

test('an invalid account option type is a provider-level error', () => {
  const issues = issuesOf(`
version: 1
providers:
  - id: anysearch
    enabled: true
    priority: 1
    credentials:
      - name: ANYSEARCH_API_KEY
        required: true
    account:
      developer: "yes"
`);
  assert.ok(issues);
  const issue = issues.find((i) => i.path.includes('developer'));
  assert.ok(issue);
  assert.match(issue.message, /boolean/);
});

test('an error is reported when credentials are required but an empty array is declared', () => {
  const issues = issuesOf(`
version: 1
providers:
  - id: anysearch
    enabled: true
    priority: 1
    credentials: []
`);
  assert.ok(issues);
  const issue = issues.find((i) => i.path === 'providers[0].credentials');
  assert.ok(issue);
  assert.match(issue.message, /requires credentials/);
});

test('priority must be an integer', () => {
  const issues = issuesOf(`
version: 1
providers:
  - id: searxng
    enabled: true
    priority: "high"
    credentials: []
`);
  assert.ok(issues);
  const issue = issues.find((i) => i.path === 'providers[0].priority');
  assert.ok(issue);
  assert.match(issue.message, /integer/);
});

test('all the problems are reported at once, not just the first one', () => {
  const issues = issuesOf(`
version: 99
providers:
  - id: nope
    enabled: "yes"
    priority: 1
    credentials: []
`);
  assert.ok(issues);
  assert.ok(issues.length >= 3, `it should report several problems, but it reported ${issues.length}`);
});

test('credential values must not appear in the configuration — only the name is declared', () => {
  // a credentials entry may declare only `name` and `required`; any other key (e.g. `value`) is rejected as an unknown field
  const issues = issuesOf(`
version: 1
providers:
  - id: anysearch
    enabled: true
    priority: 1
    credentials:
      - name: ANYSEARCH_API_KEY
        required: true
        value: sk-should-not-be-here
`);
  assert.ok(issues);
  const issue = issues.find((i) => i.path.includes('value'));
  assert.ok(issue, 'the value key in a credentials entry must be rejected');
  assert.equal(issue.level, 'provider');
});
