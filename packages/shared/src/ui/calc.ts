// Declarative formulas for rendered UI: `state.computed` maps names to small
// expressions over the document state, re-evaluated locally on every state
// change (a slider moves, a field changes) without asking the model again.
// The language is deliberately tiny — arithmetic, comparisons, a fixed set of
// functions, no loops or definitions — so every formula terminates and gives
// the same result here, on the agent service and on iOS.
import type { Value } from './types.js';

export type SeriesDef = {
  range: (number | string)[];
  x?: string;
  y?: string;
  series?: Record<string, string>;
};
export type ComputedDefs = Record<string, string | SeriesDef>;
export class CalcError extends Error {}

type Node =
  | { k: 'num'; v: number }
  | { k: 'str'; v: string }
  | { k: 'bool'; v: boolean }
  | { k: 'ref'; path: string[] }
  | { k: 'call'; name: string; args: Node[] }
  | { k: 'un'; op: string; a: Node }
  | { k: 'bin'; op: string; a: Node; b: Node };

export const LIMITS = {
  entries: 48,
  length: 400,
  depth: 32,
  points: 500,
  totalPoints: 2000,
};
const ROOTS = new Set(['form', 'data', 'ui']);
// A number typed into a text field ("1200", "-3.5", "12,000") counts as a
// number when read from state; codes with leading zeros ("00123") stay text.
const NUMERIC = /^[-+]?(0|[1-9]\d{0,2}(,\d{3})+|[1-9]\d*)(\.\d+)?$/;
const numeric = (value: Value | undefined) =>
  typeof value === 'string' && NUMERIC.test(value.trim())
    ? Number(value.trim().replaceAll(',', ''))
    : value;
/** Strict equality, except a number equals the same number written as text. */
const same = (a: Value, b: Value) =>
  a === b || (typeof a === 'number' || typeof b === 'number' ? numeric(a) === numeric(b) : false);
const ARITY: Record<string, [number, number]> = {
  min: [1, 32],
  max: [1, 32],
  sum: [1, 32],
  avg: [1, 32],
  round: [1, 2],
  floor: [1, 1],
  ceil: [1, 1],
  abs: [1, 1],
  sqrt: [1, 1],
  pow: [2, 2],
  ln: [1, 1],
  log10: [1, 1],
  exp: [1, 1],
  clamp: [3, 3],
  count: [1, 1],
  has: [2, 2],
  if: [3, 3],
  pmt: [3, 3],
  fixed: [1, 2],
  number: [1, 2],
  currency: [1, 3],
  percent: [1, 2],
};

function tokenize(source: string) {
  const tokens: string[] = [];
  const pattern =
    /\s*(\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*|'[^']*'|"[^"]*"|<=|>=|==|!=|&&|\|\||[-+*/%^()<>!,?:])/y;
  let index = 0;
  while (index < source.length) {
    pattern.lastIndex = index;
    const match = pattern.exec(source);
    if (!match) {
      if (/^\s*$/.test(source.slice(index))) break;
      throw new CalcError(`无法识别的字符：${source.slice(index).trim()[0]}`);
    }
    tokens.push(match[1]);
    index = pattern.lastIndex;
  }
  return tokens;
}

export function parse(source: string): Node {
  if (typeof source !== 'string' || !source.trim()) throw new CalcError('公式为空');
  if (source.length > LIMITS.length) throw new CalcError(`公式超过 ${LIMITS.length} 个字符`);
  const tokens = tokenize(source);
  let at = 0;
  const peek = () => tokens[at];
  const take = (expected?: string) => {
    const token = tokens[at++];
    if (expected !== undefined && token !== expected) throw new CalcError(`缺少 “${expected}”`);
    if (token === undefined) throw new CalcError('公式不完整');
    return token;
  };
  const guard = (depth: number) => {
    if (depth > LIMITS.depth) throw new CalcError('公式嵌套过深');
  };
  // Depth counts real nesting (parentheses, arguments, prefixes, branches),
  // not precedence levels, so ordinary formulas never come close.
  const binary =
    (ops: string[], next: (d: number) => Node) =>
    (depth: number): Node => {
      guard(depth);
      let left = next(depth);
      while (ops.includes(peek())) {
        const op = take();
        left = { k: 'bin', op, a: left, b: next(depth) };
      }
      return left;
    };
  const primary = (depth: number): Node => {
    guard(depth);
    const token = take();
    if (token === '(') {
      const inner = choice(depth + 1);
      take(')');
      return inner;
    }
    if (/^\d/.test(token)) return { k: 'num', v: Number(token) };
    if (/^['"]/.test(token)) return { k: 'str', v: token.slice(1, -1) };
    if (/^[A-Za-z_]/.test(token)) {
      if (peek() === '(') {
        take('(');
        if (!(token in ARITY)) throw new CalcError(`不支持的函数：${token}`);
        const args: Node[] = [];
        if (peek() !== ')') {
          args.push(choice(depth + 1));
          while (peek() === ',') {
            take(',');
            args.push(choice(depth + 1));
          }
        }
        take(')');
        const [lo, hi] = ARITY[token];
        if (args.length < lo || args.length > hi) throw new CalcError(`${token} 的参数个数不对`);
        return { k: 'call', name: token, args };
      }
      if (token === 'true' || token === 'false') return { k: 'bool', v: token === 'true' };
      return { k: 'ref', path: token.split('.') };
    }
    throw new CalcError(`意外的符号：${token}`);
  };
  // Exponent binds tighter than unary minus on its left (-2^2 = -4) and is
  // right-associative; its right side may itself be negated (2^-1).
  const power = (depth: number): Node => {
    const base = primary(depth);
    if (peek() !== '^') return base;
    take('^');
    return { k: 'bin', op: '^', a: base, b: unary(depth + 1) };
  };
  const unary = (depth: number): Node => {
    guard(depth);
    if (peek() === '-' || peek() === '!' || peek() === '+') {
      const op = take();
      return { k: 'un', op, a: unary(depth + 1) };
    }
    return power(depth);
  };
  const mul = binary(['*', '/', '%'], unary);
  const add = binary(['+', '-'], mul);
  const cmp = binary(['<', '<=', '>', '>=', '==', '!='], add);
  const and = binary(['&&'], cmp);
  const or = binary(['||'], and);
  // `cond ? a : b`, the lowest precedence and right-associative; same as if().
  const choice = (depth: number): Node => {
    guard(depth);
    const test = or(depth);
    if (peek() !== '?') return test;
    take('?');
    const yes = choice(depth + 1);
    take(':');
    return { k: 'call', name: 'if', args: [test, yes, choice(depth + 1)] };
  };
  const tree = choice(0);
  if (at < tokens.length) throw new CalcError(`多余的内容：${tokens[at]}`);
  return tree;
}

function refs(node: Node, out: Set<string>) {
  if (node.k === 'ref') out.add(node.path.join('.'));
  if (node.k === 'call') node.args.forEach((a) => refs(a, out));
  if (node.k === 'un') refs(node.a, out);
  if (node.k === 'bin') (refs(node.a, out), refs(node.b, out));
  return out;
}

const pad = (digits: unknown, fallback: number) =>
  typeof digits === 'number' && Number.isFinite(digits)
    ? Math.min(6, Math.max(0, Math.round(digits)))
    : fallback;
/** Fixed digits with "," thousands separators, independent of locale. */
function grouped(value: number, digits: number) {
  const [whole, fraction] = Math.abs(value).toFixed(digits).split('.');
  const sign = value < 0 && Number(value.toFixed(digits)) !== 0 ? '-' : '';
  return sign + whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (fraction ? '.' + fraction : '');
}

type Env = (path: string[]) => Value | undefined;
function num(value: Value | undefined): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  throw new CalcError('需要数字');
}
function evaluate(node: Node, env: Env): Value {
  switch (node.k) {
    case 'num':
    case 'str':
    case 'bool':
      return node.v;
    case 'ref': {
      const value = env(node.path);
      if (value === undefined) throw new CalcError('引用不存在');
      return value;
    }
    case 'un': {
      const value = evaluate(node.a, env);
      if (node.op === '!') return !num(value);
      return node.op === '-' ? -num(value) : num(value);
    }
    case 'bin': {
      if (node.op === '&&')
        return Boolean(num(evaluate(node.a, env))) && Boolean(num(evaluate(node.b, env)));
      if (node.op === '||')
        return Boolean(num(evaluate(node.a, env))) || Boolean(num(evaluate(node.b, env)));
      const a = evaluate(node.a, env),
        b = evaluate(node.b, env);
      if (node.op === '+' && (typeof a === 'string' || typeof b === 'string'))
        return String(a ?? '') + String(b ?? '');
      if (node.op === '==') return same(a, b);
      if (node.op === '!=') return !same(a, b);
      const x = num(a),
        y = num(b);
      switch (node.op) {
        case '+':
          return x + y;
        case '-':
          return x - y;
        case '*':
          return x * y;
        case '/':
          if (y === 0) throw new CalcError('除数为 0');
          return x / y;
        case '%':
          if (y === 0) throw new CalcError('除数为 0');
          return x % y;
        case '^':
          return x ** y;
        case '<':
          return x < y;
        case '<=':
          return x <= y;
        case '>':
          return x > y;
        case '>=':
          return x >= y;
      }
      throw new CalcError('未知运算');
    }
    case 'call': {
      if (node.name === 'if')
        return num(evaluate(node.args[0], env))
          ? evaluate(node.args[1], env)
          : evaluate(node.args[2], env);
      const args = node.args.map((a) => evaluate(a, env));
      const n = (i: number) => num(args[i]);
      // min/max/sum/avg also take lists, such as a CheckboxGroup value.
      const all = () =>
        args.flatMap((a) => (Array.isArray(a) ? a : [a])).map((v) => num(numeric(v)));
      const list = () => {
        if (!Array.isArray(args[0])) throw new CalcError('需要列表');
        return args[0];
      };
      switch (node.name) {
        case 'min':
          return Math.min(...all());
        case 'max':
          return Math.max(...all());
        case 'sum':
          return all().reduce((s, v) => s + v, 0);
        case 'avg': {
          const values = all();
          if (!values.length) throw new CalcError('列表为空');
          return values.reduce((s, v) => s + v, 0) / values.length;
        }
        case 'count':
          return list().length;
        case 'has':
          return list().some((item) => same(item, args[1]));
        case 'round': {
          const f = 10 ** pad(args[1], 0);
          return Math.round(n(0) * f) / f;
        }
        case 'floor':
          return Math.floor(n(0));
        case 'ceil':
          return Math.ceil(n(0));
        case 'abs':
          return Math.abs(n(0));
        case 'sqrt':
          if (n(0) < 0) throw new CalcError('负数不能开方');
          return Math.sqrt(n(0));
        case 'pow':
          return n(0) ** n(1);
        case 'ln':
          if (n(0) <= 0) throw new CalcError('对数需要正数');
          return Math.log(n(0));
        case 'log10':
          if (n(0) <= 0) throw new CalcError('对数需要正数');
          return Math.log10(n(0));
        case 'exp':
          return Math.exp(n(0));
        case 'clamp':
          return Math.min(Math.max(n(0), n(1)), n(2));
        case 'pmt': {
          // Level payment for a loan of n(2) over n(1) periods at rate n(0).
          const [rate, periods, principal] = [n(0), n(1), n(2)];
          if (periods <= 0) throw new CalcError('期数需要大于 0');
          return rate === 0
            ? principal / periods
            : (principal * rate) / (1 - (1 + rate) ** -periods);
        }
        case 'fixed':
          return n(0).toFixed(pad(args[1], 2));
        case 'number':
          return grouped(n(0), pad(args[1], 0));
        case 'currency': {
          const symbol = typeof args[2] === 'string' ? args[2] : '¥';
          const text = grouped(n(0), pad(args[1], 2));
          return text.startsWith('-') ? '-' + symbol + text.slice(1) : symbol + text;
        }
        case 'percent':
          return grouped(n(0) * 100, pad(args[1], 1)) + '%';
      }
      throw new CalcError(`不支持的函数：${node.name}`);
    }
  }
}
const finite = (value: Value) =>
  typeof value === 'number' && !Number.isFinite(value) ? null : value;

type Entry =
  | { name: string; kind: 'scalar'; tree: Node; deps: string[] }
  | {
      name: string;
      kind: 'series';
      range: Node[];
      x?: Node;
      lines: [string | null, Node][];
      deps: string[];
    };
export type Compiled = Entry[];

/** Parses, checks references against the initial state and orders the
 *  definitions by dependency; throws CalcError for anything invalid. */
export function compile(defs: ComputedDefs, state: Record<string, Value>): Compiled {
  const names = Object.keys(defs);
  if (names.length > LIMITS.entries) throw new CalcError(`计算值不能超过 ${LIMITS.entries} 个`);
  const entries = new Map<string, Entry>();
  const at = (name: string, fn: () => Node) => {
    try {
      return fn();
    } catch (error) {
      throw new CalcError(`${name}：${(error as Error).message}`);
    }
  };
  for (const name of names) {
    if (
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ||
      ROOTS.has(name) ||
      ['t', 'true', 'false'].includes(name)
    )
      throw new CalcError(`计算值名称无效：${name}`);
    const def = defs[name];
    if (typeof def === 'string') {
      const tree = at(name, () => parse(def));
      entries.set(name, {
        name,
        kind: 'scalar',
        tree,
        deps: [...refs(tree, new Set())],
      });
      continue;
    }
    if (!def || typeof def !== 'object' || !Array.isArray(def.range))
      throw new CalcError(`${name}：序列需要 range`);
    if (def.range.length < 2 || def.range.length > 3)
      throw new CalcError(`${name}：range 需要 [起点, 终点, 步长?]`);
    const range = def.range.map((bound) =>
      at(name, () => (typeof bound === 'number' ? { k: 'num', v: bound } : parse(String(bound)))),
    );
    const lines: [string | null, Node][] = def.series
      ? Object.entries(def.series).map(([label, y]) => [label, at(name, () => parse(y))])
      : def.y
        ? [[null, at(name, () => parse(def.y!))]]
        : [];
    if (!lines.length) throw new CalcError(`${name}：序列需要 y 或 series`);
    const x = def.x ? at(name, () => parse(def.x!)) : undefined;
    const deps = new Set<string>();
    [...range, ...lines.map(([, y]) => y), ...(x ? [x] : [])].forEach((node) => refs(node, deps));
    entries.set(name, {
      name,
      kind: 'series',
      range,
      x,
      lines,
      deps: [...deps],
    });
  }
  // Every reference is a state path that exists, another computed scalar, or
  // `t` inside a series.
  for (const entry of entries.values())
    for (const ref of entry.deps) {
      const path = ref.split('.');
      if (ROOTS.has(path[0])) {
        let value: Value | undefined = state[path[0]];
        for (const key of path.slice(1))
          value =
            value && typeof value === 'object' && !Array.isArray(value)
              ? (value as Record<string, Value>)[key]
              : undefined;
        if (value === undefined) throw new CalcError(`${entry.name}：状态 ${ref} 未初始化`);
      } else if (ref === 't') {
        if (entry.kind !== 'series') throw new CalcError(`${entry.name}：t 只能用于序列`);
      } else if (path.length > 1 || !entries.has(ref)) {
        throw new CalcError(`${entry.name}：引用了不存在的 ${ref}`);
      } else if (entries.get(ref)!.kind === 'series') {
        throw new CalcError(`${entry.name}：不能在公式中引用序列 ${ref}`);
      }
    }
  const ordered: Entry[] = [],
    visiting = new Set<string>(),
    done = new Set<string>();
  const visit = (name: string) => {
    if (done.has(name)) return;
    if (visiting.has(name)) throw new CalcError(`计算值循环引用：${name}`);
    visiting.add(name);
    for (const dep of entries.get(name)!.deps) if (entries.has(dep)) visit(dep);
    visiting.delete(name);
    done.add(name);
    ordered.push(entries.get(name)!);
  };
  names.forEach(visit);
  return ordered;
}

/** Values for every definition; a formula that cannot be evaluated (division
 *  by zero, a non-numeric input) yields null instead of breaking the UI. */
export function evaluateAll(compiled: Compiled, state: Record<string, Value>) {
  const out: Record<string, Value> = {};
  const read = (path: string[], t?: number): Value | undefined => {
    if (path.length === 1 && path[0] === 't') return t;
    if (path.length === 1) return out[path[0]];
    let value: Value | undefined = state[path[0]];
    for (const key of path.slice(1))
      value =
        value && typeof value === 'object' && !Array.isArray(value)
          ? (value as Record<string, Value>)[key]
          : undefined;
    return numeric(value);
  };
  let budget = LIMITS.totalPoints;
  for (const entry of compiled) {
    if (entry.kind === 'scalar') {
      try {
        out[entry.name] = finite(evaluate(entry.tree, (p) => read(p)));
      } catch {
        out[entry.name] = null;
      }
      continue;
    }
    try {
      const [from, to, step = 1] = entry.range.map((node) => num(evaluate(node, (p) => read(p))));
      if (step <= 0) throw new CalcError('步长需要大于 0');
      const points: Value[] = [];
      for (let t = from; t <= to + 1e-9 && points.length < LIMITS.points; t += step) {
        const env: Env = (p) => read(p, t);
        // Chart points need a string x and a finite y; a point whose y cannot
        // be computed (say ln(0) at the start of a range) is left out.
        const x = String(entry.x ? evaluate(entry.x, env) : Math.round(t * 1e9) / 1e9);
        for (const [label, y] of entry.lines) {
          if (budget-- <= 0) break;
          let value: Value;
          try {
            value = finite(evaluate(y, env));
          } catch {
            continue;
          }
          if (typeof value !== 'number') continue;
          points.push(label === null ? { x, y: value } : { x, y: value, series: label });
        }
      }
      out[entry.name] = points;
    } catch {
      out[entry.name] = [];
    }
  }
  return out;
}
