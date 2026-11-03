import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const skill = readFileSync(new URL('../../SKILL.md', import.meta.url), 'utf8');

function description(text: string): string {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  assert.ok(match !== null, 'SKILL.md must start with YAML frontmatter');
  const line = /^description:\s*(.+)$/m.exec(match[1] as string);
  assert.ok(line !== null, 'frontmatter must declare a description');
  return (line[1] as string).trim();
}

test('the skill description stays within the 1024-character discovery limit', () => {
  const value = description(skill);
  assert.ok(value.length <= 1024, `description is ${value.length} characters`);
});

test('the skill description advertises all four tools', () => {
  const value = description(skill).toLowerCase();
  for (const tool of ['search', 'fetch', 'information', 'status']) {
    assert.ok(value.includes(tool), `description must mention ${tool}`);
  }
});

test('the skill documents the information command and its structured categories', () => {
  assert.match(skill, /foragix information --query/);
  assert.match(skill, /encyclopedia/i);
  assert.match(skill, /weather/i);
});
