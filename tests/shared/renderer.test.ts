import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import {
  resolve,
  validateDocument,
  write,
  visible,
  fieldError,
  hostSurfaces,
  followupPrompts,
  hasContentBesidesFollowups,
} from '@openbot/shared/ui';
import type { RenderDocument } from '@openbot/shared/ui/types';
const fixtureRoot = new URL('../fixtures/opsique-ui/', import.meta.url);
const files = readdirSync(fixtureRoot).filter((f) => f.endsWith('.json'));
const fixture = (name = 'form-wizard.json') =>
  JSON.parse(readFileSync(new URL(name, fixtureRoot), 'utf8')) as RenderDocument;
describe('shared iOS document compatibility', () => {
  for (const file of files)
    it(`validates ${file}`, () => expect(validateDocument(fixture(file)).spec.root).toBeTruthy());
  // Agents send these examples (the Platform runtime stub does), so every one
  // must render in chat, not only in the gallery.
  const contractRoot = new URL('../../packages/shared/ui-contract/fixtures/', import.meta.url);
  for (const file of readdirSync(contractRoot).filter((f) => f.endsWith('.json')))
    it(`validates contract example ${file} as a chat document`, () => {
      const {
        name: _name,
        title: _title,
        ...doc
      } = JSON.parse(readFileSync(new URL(file, contractRoot), 'utf8'));
      const document = {
        ...doc,
        protocolVersion: 'opsique-ui/0.1',
        context: { threadId: 't', viewId: 'v', revision: 1 },
      };
      expect(validateDocument(document).spec.root).toBeTruthy();
    });
  it('rejects unknown props, components, cyclic and unreachable trees', () => {
    for (const mutate of [
      (d: RenderDocument) => {
        d.spec.elements[d.spec.root].type = 'Script';
      },
      (d: RenderDocument) => {
        d.spec.elements[d.spec.root].props.danger = true;
      },
      (d: RenderDocument) => {
        d.spec.elements[d.spec.root].children.push(d.spec.root);
      },
      (d: RenderDocument) => {
        d.spec.elements.unreachable = {
          type: 'Text',
          props: { text: 'oops' },
          children: [],
        };
      },
    ]) {
      const d = fixture();
      mutate(d);
      expect(() => validateDocument(d)).toThrow();
    }
  });
  it('keeps server data read-only and blocks prototype writes', () => {
    const state = {
      data: { count: 2 },
      form: { profile: { name: '' } },
      ui: { step: 0 },
    };
    expect(() => write(state, '/data/count', 3)).toThrow();
    expect(() => write(state, '/form/__proto__/polluted', true)).toThrow();
    expect(write(state, '/form/profile/name', 'Alex').form.profile).toEqual({
      name: 'Alex',
    });
    expect(state.form.profile.name).toBe('');
  });
  it('resolves bindings, repeat scope and conditions', () => {
    const state = { data: { ready: true }, form: { name: 'Alex' }, ui: {} };
    expect(resolve({ $bindState: '/form/name' }, state)).toBe('Alex');
    const row = { item: { name: 'Row' }, index: 2, instance: 'r' };
    // $item names a field of the repeated item, as in the Swift renderer.
    expect(resolve({ $item: 'name' }, state, row)).toBe('Row');
    expect(resolve({ $item: '' }, state, row)).toEqual({ name: 'Row' });
    expect(() => resolve({ $item: '/name' }, state, row)).toThrow();
    expect(() => resolve({ $item: 'a.b' }, state, row)).toThrow();
    expect(
      visible(
        {
          $and: [
            { $state: '/data/ready', eq: true },
            { $state: '/form/name', neq: '' },
          ],
        },
        state,
      ),
    ).toBe(true);
  });
  it('validates required fields and unavailable options', () => {
    const el = {
      type: 'Select',
      props: {
        label: '范围',
        value: { $bindState: '/form/value' },
        required: true,
        options: [{ label: '可用', value: 'yes' }],
      },
      children: [],
    };
    expect(fieldError(el, { data: {}, form: { value: '' }, ui: {} })).toContain('请填写');
    expect(fieldError(el, { data: {}, form: { value: 'no' }, ui: {} })).toContain('有效选项');
  });
});

describe('hostSurfaces', () => {
  const spec = (
    root: string,
    elements: Record<string, [string, string[], Record<string, unknown>?]>,
  ) => ({
    root,
    elements: Object.fromEntries(
      Object.entries(elements).map(([id, [type, children, props]]) => [
        id,
        { type, children, props: (props ?? {}) as never },
      ]),
    ),
  });
  const hosts = (s: ReturnType<typeof spec>) => [...hostSurfaces(s)].sort();
  it('puts bare content on one surface', () => {
    expect(hosts(spec('f', { f: ['TextField', []] }))).toEqual(['f']);
    expect(
      hosts(
        spec('s', {
          s: ['Stack', ['t', 'm']],
          t: ['Text', []],
          m: ['Metric', []],
        }),
      ),
    ).toEqual(['s']);
    expect(
      hosts(
        spec('c', {
          c: ['Card', ['t'], { variant: 'clear' }],
          t: ['Text', []],
        }),
      ),
    ).toEqual(['c']);
  });
  it('adds nothing when surfaces are already there', () => {
    expect(hosts(spec('c', { c: ['Card', ['t']], t: ['Text', []] }))).toEqual([]);
    expect(hosts(spec('g', { g: ['GaugeChart', []] }))).toEqual([]);
    expect(
      hosts(
        spec('d', {
          d: ['Dashboard', ['h', 'p', 'i']],
          h: ['Text', []],
          p: ['ProductCard', []],
          i: ['ItemCard', []],
        }),
      ),
    ).toEqual([]);
  });
  it('only fills the gaps beside existing surfaces, keeping them as peers', () => {
    expect(
      hosts(
        spec('s', {
          s: ['Stack', ['h', 'f', 'c']],
          h: ['Heading', []],
          f: ['TextField', []],
          c: ['Chart', []],
        }),
      ),
    ).toEqual(['f']);
  });
  it('never flattens a shipped example', () => {
    for (const name of readdirSync(fixtureRoot).filter((f) => f.endsWith('.json'))) {
      const doc = JSON.parse(readFileSync(new URL(name, fixtureRoot), 'utf8'));
      expect(hostSurfaces(doc.spec).has(doc.spec.root), name).toBe(false);
    }
  });
});

describe('followups as composer suggestions', () => {
  const doc = (elements: Record<string, unknown>, root = 's') =>
    ({
      protocolVersion: 'opsique-ui/0.1',
      context: { threadId: 't', viewId: 'v', revision: 1 },
      spec: { root, elements },
      state: {
        data: { more: ['看看上周', '导出表格'] },
        form: {},
        ui: { followup: '' },
      },
    }) as never;
  const followup = (prompts: unknown) => ({
    type: 'Followup',
    props: { prompts, value: { $bindState: '/ui/followup' } },
    children: [],
  });
  it('collects, trims, de-duplicates and caps prompts, including state-bound ones', () => {
    const d = doc({
      s: { type: 'Stack', props: {}, children: ['a', 'b'] },
      a: followup([' 对比上周 ', '对比上周', '', '列出异常主播']),
      b: followup({ $state: '/data/more' }),
    });
    expect(followupPrompts(d)).toEqual(['对比上周', '列出异常主播', '看看上周', '导出表格']);
  });
  it('knows when a document is only suggestions', () => {
    const only = doc({
      s: { type: 'Stack', props: {}, children: ['a'] },
      a: followup(['x']),
    });
    expect(hasContentBesidesFollowups((only as { spec: never }).spec)).toBe(false);
    const mixed = doc({
      s: { type: 'Stack', props: {}, children: ['t', 'a'] },
      t: { type: 'Text', props: { text: '概览' }, children: [] },
      a: followup(['x']),
    });
    expect(hasContentBesidesFollowups((mixed as { spec: never }).spec)).toBe(true);
  });
});
