import catalog from './catalog.generated.js';
import generatedCheck from './schema.generated.js';
const checkSchema = generatedCheck as ((data: unknown) => boolean) & {
  errors?: unknown[];
};
import type { Value, State, RenderDocument, Scope, ElementSpec } from './types.js';
import { compile, evaluateAll, type Compiled, type ComputedDefs } from './calc.js';

export const componentCatalog = catalog.components;
const dangerous = new Set(['__proto__', 'prototype', 'constructor']);
export function segments(path: string): string[] {
  if (!path.startsWith('/')) throw new Error('状态路径必须为 JSON Pointer');
  const parts = path
    .slice(1)
    .split('/')
    .map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'));
  if (parts.some((p) => dangerous.has(p))) throw new Error('非法状态路径');
  return parts;
}
export function read(value: unknown, path: string): Value | undefined {
  if (path === '') return value as Value;
  return segments(path).reduce<unknown>(
    (v, p) =>
      v !== null && typeof v === 'object' && Object.hasOwn(v, p)
        ? (v as Record<string, unknown>)[p]
        : undefined,
    value,
  ) as Value | undefined;
}
export function write(state: State, path: string, value: Value): State {
  const parts = segments(path);
  if (!['form', 'ui'].includes(parts[0]) || parts.length < 2)
    throw new Error('仅允许写入 form 或 ui 的字段');
  const next = structuredClone(state);
  let target: Record<string, Value> = next as unknown as Record<string, Value>;
  for (const part of parts.slice(0, -1)) {
    if (!target[part] || typeof target[part] !== 'object') throw new Error('状态路径不存在');
    target = target[part] as Record<string, Value>;
  }
  target[parts.at(-1)!] = value;
  return next;
}
export function resolve(value: Value | undefined, state: State, scope?: Scope): Value {
  if (value === undefined) return null;
  if (Array.isArray(value)) return value.map((v) => resolve(v, state, scope));
  if (value && typeof value === 'object') {
    if ('$state' in value || '$bindState' in value)
      return read(state, String(value.$state ?? value.$bindState)) ?? null;
    if ('$item' in value) {
      // A field of the repeated item, as in the Swift renderer; "" is the item.
      const field = String(value.$item);
      if (field.includes('/') || field.includes('.'))
        throw new Error('$item 只能引用列表项的字段：' + field);
      return (field ? read(scope?.item, '/' + field) : scope?.item) ?? null;
    }
    if ('$index' in value) return scope?.index ?? 0;
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolve(v, state, scope)]));
  }
  return value;
}
export function visible(condition: Value | undefined, state: State, scope?: Scope): boolean {
  if (condition === undefined) return true;
  if (typeof condition === 'boolean') return condition;
  if (!condition || typeof condition !== 'object' || Array.isArray(condition)) return false;
  if ('$and' in condition)
    return (condition.$and as Value[]).every((v) => visible(v, state, scope));
  if ('$or' in condition) return (condition.$or as Value[]).some((v) => visible(v, state, scope));
  const target = resolve(condition, state, scope);
  let result =
    'eq' in condition
      ? target === condition.eq
      : 'neq' in condition
        ? target !== condition.neq
        : Boolean(target);
  if (condition.not) result = !result;
  return result;
}
export function validateDocument(raw: unknown): RenderDocument {
  let size = 0;
  const active = new WeakSet<object>();
  function bounded(value: unknown, depth = 0) {
    if (++size > 30000 || depth > 40) throw new Error('渲染文档超过限制');
    if (value && typeof value === 'object') {
      if (active.has(value)) throw new Error('渲染文档存在循环');
      active.add(value);
      for (const [key, child] of Object.entries(value)) {
        if (dangerous.has(key)) throw new Error('渲染文档包含非法字段');
        bounded(child, depth + 1);
      }
      active.delete(value);
    }
  }
  bounded(raw);
  if (!checkSchema(raw))
    throw new Error('渲染文档格式错误：' + JSON.stringify(checkSchema.errors?.slice(0, 3)));
  const doc = raw as RenderDocument;
  // Formulas are checked here; the rest of validation sees their values.
  let compiled: Compiled | null = null;
  if (doc.state.computed)
    try {
      compiled = compile(doc.state.computed as ComputedDefs, doc.state);
    } catch (error) {
      throw new Error('计算公式错误：' + (error as Error).message);
    }
  const view = withComputed(doc.state, compiled);
  const entries = Object.entries(doc.spec.elements);
  if (entries.length > 256) throw new Error('组件数量超过 256');
  const seen = new Set<string>();
  let visits = 0;
  function visit(id: string, ancestors: Set<string>, depth: number) {
    if (depth > 16 || ++visits > 2048) throw new Error('组件树超过限制');
    if (ancestors.has(id)) throw new Error('组件存在循环引用');
    const el = doc.spec.elements[id];
    if (!el) throw new Error('组件引用不存在：' + id);
    seen.add(id);
    const definition = componentCatalog[el.type as keyof typeof componentCatalog];
    if (!definition) throw new Error('未知组件：' + el.type);
    const properties = definition.properties as Record<
      string,
      { type: string; writable?: boolean; values?: string[] }
    >;
    for (const name of definition.required)
      if (!(name in el.props)) throw new Error(`${id} 缺少 ${name}`);
    for (const [key, value] of Object.entries(el.props)) {
      const rule = properties[key];
      if (!rule) throw new Error(`${el.type} 不支持属性 ${key}`);
      if (
        value &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        ('$bindState' in value || '$state' in value)
      ) {
        if (Object.keys(value).length !== 1) throw new Error('状态绑定包含额外字段');
        const path = String(value.$bindState ?? value.$state);
        if ('$bindState' in value && (!rule.writable || !/^\/(form|ui)\//.test(path)))
          throw new Error('非法双向绑定');
        if (read(view, path) === undefined) throw new Error('绑定路径不存在：' + path);
      }
      const resolved = resolve(value, view);
      if (
        resolved === null ||
        (value &&
          typeof value === 'object' &&
          !Array.isArray(value) &&
          ('$item' in value || '$index' in value))
      )
        continue;
      if (
        rule.type === 'array'
          ? !Array.isArray(resolved)
          : rule.type === 'object'
            ? typeof resolved !== 'object' || Array.isArray(resolved)
            : rule.type === 'scalar'
              ? !['string', 'number', 'boolean'].includes(typeof resolved)
              : typeof resolved !== rule.type
      )
        throw new Error(`${id}.${key} 类型错误`);
      if (rule.values && !rule.values.includes(String(resolved)))
        throw new Error(`${id}.${key} 值不支持`);
    }
    for (const [event, binding] of Object.entries(el.on ?? {})) {
      if (
        !(definition.events as readonly string[]).includes(event) ||
        !catalog.actions.includes(binding.action)
      )
        throw new Error('未知事件或动作');
      if (binding.action === 'setState') {
        const path = String(binding.params.statePath);
        if (!/^\/(form|ui)\//.test(path)) throw new Error('非法写入路径');
        segments(path);
      } else if (['focus', 'blur', 'change'].includes(event))
        throw new Error('控件事件只能更新本地状态');
    }
    for (const slot of Object.keys(el.slots ?? {}))
      if (!(definition.slots as readonly string[]).includes(slot)) throw new Error('未知插槽');
    const path = new Set(ancestors);
    path.add(id);
    for (const child of [...el.children, ...Object.values(el.slots ?? {}).flat()])
      visit(child, path, depth + 1);
    if (el.repeat) {
      const items = read(view, el.repeat.statePath);
      if (!Array.isArray(items) || items.length > 200) throw new Error('重复列表超限');
      const keys = items.map((v) => read(v, '/' + el.repeat!.key));
      if (keys.some((v) => v === null || v === undefined) || new Set(keys).size !== keys.length)
        throw new Error('重复列表需要唯一 key');
    }
  }
  visit(doc.spec.root, new Set(), 0);
  if (seen.size !== entries.length) throw new Error('存在不可达组件');
  let expanded = 0;
  function measure(id: string) {
    if (++expanded > 2048) throw new Error('重复渲染组件数量超过限制');
    const el = doc.spec.elements[id];
    const children = [...el.children, ...Object.values(el.slots ?? {}).flat()];
    const repetitions = el.repeat ? (read(view, el.repeat.statePath) as Value[]).length : 1;
    for (let i = 0; i < repetitions; i++) for (const child of children) measure(child);
  }
  measure(doc.spec.root);
  return structuredClone(doc);
}
export function fieldError(el: ElementSpec, state: State, scope?: Scope): string | undefined {
  const p = resolve(el.props as Value, state, scope) as Record<string, Value>;
  const value = p.value;
  if (
    p.required &&
    ((el.type === 'DateRangePicker' && Array.isArray(value) && value.some((v) => !v)) ||
      value === '' ||
      value == null ||
      (Array.isArray(value) && value.length === 0) ||
      (el.type === 'Checkbox' && value !== true))
  )
    return '请填写' + String(p.label ?? '此字段');
  if (
    typeof value === 'string' &&
    typeof p.maxLength === 'number' &&
    [...value].length > p.maxLength
  )
    return `最多 ${p.maxLength} 个字符`;
  if (
    typeof value === 'number' &&
    ((typeof p.min === 'number' && value < p.min) || (typeof p.max === 'number' && value > p.max))
  )
    return '数值超出范围';
  if (Array.isArray(p.options)) {
    const allowed = p.options
      .filter((v) => v && typeof v === 'object' && !Array.isArray(v) && !v.disabled)
      .map((v) => (v as Record<string, Value>).value);
    const chosen = Array.isArray(value) ? value : value ? [value] : [];
    if (chosen.some((v) => !allowed.includes(v))) return '请选择有效选项';
  }
}

// Components that draw their own surface (background, radius, shadow).
const surfaceTypes = new Set([
  'ProductCard',
  'RecordCard',
  'ItemCard',
  'ListBlock',
  'GeneratedComposition',
  'Callout',
  'CodeBlock',
  'Image',
  'Followup',
]);
// Pure layout: no surface of their own.
const containerTypes = new Set([
  'Stack',
  'Form',
  'SwitchGroup',
  'Grid',
  'Dashboard',
  'ItemCardGroup',
  'Row',
  'ActionGroup',
  'Steps',
  'Tabs',
  'Accordion',
  'ProductSignals',
]);
// Section labels may sit between surfaces without needing one themselves.
const labelTypes = new Set(['Text', 'Heading', 'Divider', 'Spacer']);
function surfaced(spec: RenderDocument['spec'], id: string, depth = 0): boolean {
  const el = spec.elements[id];
  if (!el) return true;
  if (el.type === 'Card') return el.props.variant !== 'clear';
  if (surfaceTypes.has(el.type) || /Chart$|^Heatmap$/.test(el.type)) return true;
  if (!containerTypes.has(el.type) || depth > 3) return false;
  const content = childrenOf(el).filter((child) => !labelTypes.has(spec.elements[child]?.type));
  return content.length > 0 && content.every((child) => surfaced(spec, child, depth + 1));
}
const childrenOf = (el: ElementSpec) => [...el.children, ...Object.values(el.slots ?? {}).flat()];
/** Elements the host should place on a surface so every block of content has
 *  exactly one background:
 *  - nothing when the root, or every non-label child of a root layout,
 *    already draws its own surface (section headings may sit between them);
 *  - the root itself when its content has no surface at all (a bare form,
 *    text with metrics, a lone table…);
 *  - otherwise only the root layout's children that lack one, so cards and
 *    charts already present stay as peers instead of being flattened. */
export function hostSurfaces(spec: RenderDocument['spec']): Set<string> {
  const root = spec.elements[spec.root];
  if (!root || surfaced(spec, spec.root)) return new Set();
  if (!containerTypes.has(root.type)) return new Set([spec.root]);
  const content = childrenOf(root).filter((child) => !labelTypes.has(spec.elements[child]?.type));
  if (!content.some((child) => surfaced(spec, child))) return new Set([spec.root]);
  return new Set(content.filter((child) => !surfaced(spec, child)));
}

/** Suggested next prompts from a document's Followup components. The chat
 *  shows them above the composer, detached from the message. */
export function followupPrompts(doc: RenderDocument): string[] {
  const prompts = Object.entries(doc.spec.elements)
    .filter(([, el]) => el.type === 'Followup')
    .flatMap(([id, el]) => {
      const props = resolve(el.props as Value, doc.state, { instance: id });
      const value = (props as Record<string, Value> | null)?.prompts;
      return Array.isArray(value) ? value : [];
    })
    .filter((v): v is string => typeof v === 'string' && v.trim() !== '')
    .map((v) => v.trim());
  return [...new Set(prompts)].slice(0, 4);
}
/** Whether anything other than layout and Followups would render. */
export function hasContentBesidesFollowups(spec: RenderDocument['spec']) {
  const visit = (id: string, depth: number): boolean => {
    const el = spec.elements[id];
    if (!el || el.type === 'Followup' || depth > 12) return false;
    if (!containerTypes.has(el.type)) return true;
    return childrenOf(el).some((child) => visit(child, depth + 1));
  };
  return visit(spec.root, 0);
}

/** The state components read: stored state plus the current computed values. */
export function withComputed(state: State, compiled: Compiled | null): State {
  return compiled
    ? {
        ...state,
        computed: evaluateAll(compiled, state as Record<string, Value>),
      }
    : state;
}
export function compileDocument(doc: RenderDocument): Compiled | null {
  return doc.state.computed ? compile(doc.state.computed as ComputedDefs, doc.state) : null;
}
