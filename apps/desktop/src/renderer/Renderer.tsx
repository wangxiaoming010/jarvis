import './base.css';
import './ios-cards.css';
import './theme.css';
import {
  Component,
  useMemo,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import {
  Button,
  Card,
  Input,
  TextArea,
  Select,
  Label,
  ListBox,
  Switch,
  Checkbox,
  Spinner,
  Popover,
} from '@heroui/react';
import { DateInput, DateRangeInput, TimeInput } from './dates';
import { ArrowUpRight, Check, ChevronDown, ChevronRight, Star } from 'lucide-react';
import { ChartView, type Props } from './charts';
import { FlowView, Fullscreen, ImageView, MapView } from './media';
import {
  compileDocument,
  fieldError,
  hostSurfaces,
  read,
  resolve,
  validateDocument,
  visible,
  withComputed,
  write,
} from './engine';
import type { ActionEnvelope, ElementSpec, RenderDocument, Scope, State, Value } from './types';
import { Scene } from './scenes';
import { Diagram } from './diagram';
import { Icon } from './icons';
import { motion } from 'motion/react';
import { soft, useEntered } from './motion';
// Field errors appear like iOS errorIn: 150ms ease-out.
const errorIn = {
  initial: { opacity: 0, y: -2 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.15, ease: 'easeOut' },
} as const;
import {
  CodeView,
  formatValue,
  prepareRenderPress,
  ProgressTrack,
  RenderAccordion,
  StepPage,
} from './presentation';

type RendererProps = {
  document: RenderDocument;
  /** In chat, Followup prompts become composer suggestions instead. */
  hideFollowups?: boolean;
  onAction?: (action: ActionEnvelope) => Promise<void>;
  disabled?: boolean;
  onStateChange?: (state: State) => void;
  readOnlyNote?: string;
};
export function Renderer(props: RendererProps) {
  const result = useMemo(() => {
    try {
      return { doc: validateDocument(props.document) };
    } catch (error) {
      return { error: String(error) };
    }
  }, [props.document.spec, props.document.context.viewId, props.document.context.revision]);
  return result.doc ? (
    <RenderBoundary key={`${result.doc.context.viewId}:${result.doc.context.revision}`}>
      <RenderSession {...props} document={result.doc} />
    </RenderBoundary>
  ) : (
    <div role="alert" className="callout danger">
      无法显示卡片，请让 Bot 重新发送。
    </div>
  );
}
function RenderSession({
  document: doc,
  onAction,
  disabled = false,
  hideFollowups = false,
  onStateChange,
  readOnlyNote,
}: RendererProps) {
  const [state, setState] = useState(doc.state),
    [errors, setErrors] = useState<Record<string, string>>({}),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState('');
  const presentation = useRef<Record<string, { selected?: number; expanded?: number[] }>>({});
  const stateRef = useRef(state),
    inFlight = useRef(false);
  // Components read stored state plus live formula values; writes go to state.
  const compiled = useMemo(() => compileDocument(doc), [doc]);
  const view = useMemo(() => withComputed(state, compiled), [state, compiled]);
  const current = () => withComputed(stateRef.current, compiled);
  function commit(next: State) {
    stateRef.current = next;
    setState(next);
    onStateChange?.(next);
  }
  function bind(el: ElementSpec, value: Value) {
    const path = (el.props.value as Record<string, Value>)?.$bindState;
    if (typeof path === 'string') commit(write(stateRef.current, path, value));
  }
  function collect(ids: string[], scope: Scope, formPath?: string): Record<string, string> {
    const found: Record<string, string> = {};
    let budget = 0;
    function scan(id: string, s: Scope) {
      if (++budget > 4096) return;
      const el = doc.spec.elements[id];
      if (!visible(el.visible, current(), s)) return;
      const path = (el.props.value as Record<string, Value>)?.$bindState;
      if (
        path &&
        (!formPath || String(path) === formPath || String(path).startsWith(formPath + '/'))
      ) {
        const error = fieldError(el, current(), s);
        if (error) found[s.instance] = error;
      }
      if (el.repeat) {
        const items = read(stateRef.current, el.repeat.statePath) as Value[];
        items.forEach((item, index) => {
          const key = encodeKey(read(item, '/' + el.repeat!.key));
          el.children.forEach((child) =>
            scan(child, {
              item,
              index,
              instance: s.instance + '/item:' + key + '/' + child,
            }),
          );
        });
      } else
        el.children.forEach((child) => scan(child, { ...s, instance: s.instance + '/' + child }));
      for (const [slot, ids] of Object.entries(el.slots ?? {}))
        ids.forEach((child) =>
          scan(child, {
            ...s,
            instance: s.instance + '/slot:' + slot + '/' + child,
          }),
        );
    }
    ids.forEach((id) => scan(id, scope));
    return found;
  }
  function check(ids: string[], s: Scope, formPath?: string) {
    const found = collect(ids, s, formPath);
    setErrors(found);
    return !Object.keys(found).length;
  }
  async function event(id: string, name: string, scope: Scope) {
    const el = doc.spec.elements[id],
      binding = el.on?.[name];
    if (!binding || disabled) return;
    try {
      const params = resolve(binding.params, current(), scope) as Record<string, Value>;
      if (binding.action === 'setState') {
        commit(write(stateRef.current, String(params.statePath), params.value));
        return;
      }
      if (inFlight.current) return;
      if (
        binding.action === 'submitForm' &&
        !check([doc.spec.root], { instance: doc.spec.root }, String(params.formPath ?? '/form'))
      )
        return;
      if (!onAction) {
        setNotice('预览模式，操作不会提交。');
        return;
      }
      inFlight.current = true;
      setBusy(true);
      setNotice('');
      await onAction({
        requestId: crypto.randomUUID(),
        context: doc.context,
        componentId: id,
        instanceId: scope.instance,
        event: name,
        action: binding.action,
        params,
      });
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  // Blocks without a background of their own get exactly one from the host.
  const hosts = useMemo(() => hostSurfaces(doc.spec), [doc.spec]);
  function node(id: string, scope: Scope = { instance: doc.spec.root }, depth = 0): ReactNode {
    const el = doc.spec.elements[id];
    if (!el || !visible(el.visible, view, scope)) return null;
    const p = resolve(el.props, view, scope) as Props;
    // A hosted element sits on a host surface, so its inner Cards are nested.
    const hosted = hosts.has(id);
    const childDepth = depth + (el.type === 'Card' || hosted ? 1 : 0);
    const instance = scope.instance,
      error = errors[instance],
      locked = disabled || busy || Boolean(p.disabled);
    const children = el.repeat
      ? (read(state, el.repeat.statePath) as Value[]).map((item, index) => (
          <div key={String(read(item, '/' + el.repeat!.key))} className="repeat-item">
            {el.children.map((key) =>
              node(
                key,
                {
                  item,
                  index,
                  instance:
                    scope.instance +
                    '/item:' +
                    encodeKey(read(item, '/' + el.repeat!.key)) +
                    '/' +
                    key,
                },
                childDepth,
              ),
            )}
          </div>
        ))
      : el.children.map((key) =>
          node(key, { ...scope, instance: scope.instance + '/' + key }, childDepth),
        );
    const slot = (name: string) =>
      el.slots?.[name]?.map((key) =>
        node(
          key,
          {
            ...scope,
            instance: scope.instance + '/slot:' + name + '/' + key,
          },
          depth,
        ),
      );
    const trigger = (name: string) => void event(id, name, scope);
    const blur = () => {
      const message = fieldError(el, current(), scope);
      setErrors((e) => ({ ...e, [instance]: message ?? '' }));
      trigger('blur');
    };
    const change = (value: Value) => {
      bind(el, value);
      setErrors((e) => ({ ...e, [instance]: '' }));
      trigger('change');
    };
    const field = (control: ReactNode) => (
      <div key={instance} className="render-field">
        <label className="field-label" htmlFor={instance}>
          {p.label}
          {p.required && <span className="required"> *</span>}
        </label>
        {control}
        {p.description && <small className="muted">{p.description}</small>}
        {error && (
          <motion.small role="alert" className="error" {...errorIn}>
            {error}
          </motion.small>
        )}
      </div>
    );
    let output: ReactNode;
    switch (el.type) {
      case 'Card':
        output = (
          <Card className={`render-card ${p.variant ?? ''} ${depth > 0 ? 'nested' : ''}`}>
            {slot('header') ?? (p.title && <h3>{p.title}</h3>)}
            <div className="stack">{children}</div>
            {el.slots?.footer && <footer>{slot('footer')}</footer>}
          </Card>
        );
        break;
      case 'Stack':
      case 'Form':
      case 'SwitchGroup':
        output = (
          <div className={`stack ${p.spacing ?? ''}`}>
            {p.title && <h3>{p.title}</h3>}
            {p.description && <p className="muted">{p.description}</p>}
            {children}
          </div>
        );
        break;
      case 'Grid':
      case 'Dashboard':
      case 'ItemCardGroup':
        output = (
          <section className="composition-layout">
            {p.title && <h3>{p.title}</h3>}
            {p.description && <p className="muted">{p.description}</p>}
            <div
              className={
                p.layout === 'stack' || (el.type !== 'Grid' && !p.layout)
                  ? 'stack'
                  : p.layout === 'horizontal'
                    ? 'horizontal'
                    : 'render-grid'
              }
            >
              {children}
            </div>
          </section>
        );
        break;
      case 'Row':
      case 'ActionGroup':
        output = <div className="row wrap">{children}</div>;
        break;
      case 'Text':
        output =
          p.variant === 'heading' ? (
            <h3>{p.text}</h3>
          ) : (
            <p className={`render-text ${p.variant ?? ''}`}>{p.text}</p>
          );
        break;
      case 'Heading':
        output = <h3 className={`heading level-${p.level ?? 2}`}>{p.text}</h3>;
        break;
      case 'Divider':
        output = <hr />;
        break;
      case 'Spacer':
        output = <div style={{ height: Math.min(p.size ?? 16, 200) }} />;
        break;
      case 'Metric':
        output = (
          <div className="metric">
            <span className="muted">{p.label}</span>
            <strong>{String(p.value ?? '—')}</strong>
          </div>
        );
        break;
      case 'Badge':
        output = <span className={`badge ${p.tone ?? ''} ${p.variant ?? ''}`}>{p.label}</span>;
        break;
      case 'Button':
        output = (
          <Button
            isDisabled={locked || !el.on?.press}
            className={p.variant === 'outline' ? 'render-outline' : undefined}
            variant={p.variant === 'outline' ? 'tertiary' : (p.variant ?? 'primary')}
            onPress={() => trigger('press')}
          >
            {p.icon && <Icon name={p.icon} size={16} />}{' '}
            {busy ? (
              <>
                <Spinner size="sm" />
                提交中…
              </>
            ) : (
              p.label
            )}
          </Button>
        );
        break;
      case 'TextField':
      case 'TextArea':
      case 'NumberField': {
        const common = {
          id: instance,
          'aria-label': p.label,
          'aria-invalid': !!error,
          disabled: locked,
          value: p.value ?? '',
          onFocus: () => trigger('focus'),
          onBlur: blur,
          placeholder: p.placeholder ?? '',
          className: 'w-full',
        };
        output = field(
          el.type === 'TextArea' ? (
            <TextArea
              {...common}
              rows={p.rows ?? 4}
              style={{ height: (p.rows ?? 4) * 24 + 32 }}
              onChange={(e) => change(e.target.value)}
            />
          ) : (
            <Input
              {...common}
              type={
                (
                  {
                    NumberField: 'number',
                  } as Record<string, string>
                )[el.type] ?? 'text'
              }
              min={p.min}
              max={p.max}
              step={p.step}
              onChange={(e) =>
                change(el.type === 'NumberField' ? Number(e.target.value) : e.target.value)
              }
            />
          ),
        );
        break;
      }
      case 'Select':
        output = (
          <div className="render-field">
            <Select
              aria-label={p.label}
              isDisabled={locked}
              value={p.value || null}
              onChange={(value) => change(String(value ?? ''))}
              onFocus={() => trigger('focus')}
              onBlur={blur}
            >
              <Label>
                {p.label}
                {p.required ? ' *' : ''}
              </Label>
              <Select.Trigger>
                <Select.Value />
                <Select.Indicator />
              </Select.Trigger>
              <Select.Popover className="render-overlay">
                <ListBox>
                  {p.options.map((o: Props) => (
                    <ListBox.Item
                      key={o.value}
                      id={o.value}
                      textValue={o.label}
                      isDisabled={o.disabled}
                    >
                      {o.label}
                    </ListBox.Item>
                  ))}
                </ListBox>
              </Select.Popover>
            </Select>
            {error && (
              <motion.small className="error" role="alert" {...errorIn}>
                {error}
              </motion.small>
            )}
          </div>
        );
        break;
      case 'Switch':
        output = (
          <Switch
            isSelected={!!p.value}
            isDisabled={locked}
            onChange={change}
            onFocus={() => trigger('focus')}
            onBlur={blur}
          >
            <Switch.Content>
              <Switch.Control>
                <Switch.Thumb />
              </Switch.Control>
              <Label>{p.label}</Label>
            </Switch.Content>
          </Switch>
        );
        break;
      case 'Checkbox':
        output = (
          <div>
            <Checkbox
              isSelected={!!p.value}
              isDisabled={locked}
              onChange={change}
              onFocus={() => trigger('focus')}
              onBlur={blur}
            >
              <Checkbox.Content>
                <Checkbox.Control>
                  <Checkbox.Indicator />
                </Checkbox.Control>
                <Label>{p.label}</Label>
              </Checkbox.Content>
            </Checkbox>
            {error && (
              <motion.small role="alert" className="error" {...errorIn}>
                {error}
              </motion.small>
            )}
          </div>
        );
        break;
      case 'Slider':
        output = field(
          <div className="row">
            <input
              id={instance}
              aria-label={p.label}
              style={
                {
                  '--fill': `${(((p.value ?? 0) - (p.min ?? 0)) / ((p.max ?? 100) - (p.min ?? 0) || 1)) * 100}%`,
                } as CSSProperties
              }
              type="range"
              min={p.min ?? 0}
              max={p.max ?? 100}
              step={p.step ?? 1}
              value={p.value}
              disabled={locked}
              onChange={(e) => change(Number(e.target.value))}
              onFocus={() => trigger('focus')}
              onBlur={blur}
            />
            <span>
              {p.value}
              {p.unit}
            </span>
          </div>,
        );
        break;
      case 'Radio':
      case 'CheckboxGroup':
      case 'ComboBox':
      case 'ToggleGroup':
        output = field(
          <Choice type={el.type} p={p} disabled={locked} onChange={change} onBlur={blur} />,
        );
        break;
      case 'DatePicker':
      case 'TimeField':
      case 'DateRangePicker': {
        // HeroUI pickers carry their own Label, like Select.
        const Picker = {
          DatePicker: DateInput,
          TimeField: TimeInput,
          DateRangePicker: DateRangeInput,
        }[el.type]!;
        output = (
          <div className="render-field">
            <Picker
              label={p.label}
              required={p.required}
              disabled={locked}
              invalid={!!error}
              value={p.value}
              onChange={change as never}
              onFocus={() => trigger('focus')}
              onBlur={blur}
            />
            {p.description && <small className="muted">{p.description}</small>}
            {error && (
              <motion.small className="error" role="alert" {...errorIn}>
                {error}
              </motion.small>
            )}
          </div>
        );
        break;
      }
      case 'Steps':
        output = (
          <div className="stack steps">
            <div className="stack compact">
              <p className="step-caption">
                第 {(p.value ?? 0) + 1} / {p.labels.length} 步 · {p.labels[p.value ?? 0]}
              </p>
              <ProgressTrack value={(p.value ?? 0) + 1} max={p.labels.length} label="表单进度" />
            </div>
            <StepPage index={p.value ?? 0}>
              {node(
                el.children[p.value ?? 0],
                {
                  ...scope,
                  instance: scope.instance + '/' + el.children[p.value ?? 0],
                },
                depth,
              )}
            </StepPage>
            <div className="row step-navigation">
              <Button
                variant="secondary"
                isDisabled={locked || p.value <= 0}
                onPress={() => change(p.value - 1)}
              >
                上一步
              </Button>
              {p.value < p.labels.length - 1 && (
                <Button
                  isDisabled={locked}
                  onPress={() => {
                    if (
                      check([el.children[p.value]], {
                        ...scope,
                        instance: scope.instance + '/' + el.children[p.value],
                      })
                    )
                      change(p.value + 1);
                  }}
                >
                  下一步
                </Button>
              )}
            </div>
          </div>
        );
        break;
      case 'Tabs':
      case 'ProductSignals':
        output = (
          <LocalTabs
            labels={p.labels}
            initial={presentation.current[instance]?.selected ?? p.defaultValue ?? 0}
            onSelected={(selected) => {
              presentation.current[instance] = {
                ...presentation.current[instance],
                selected,
              };
            }}
            panels={children}
            title={p.title}
          />
        );
        break;
      case 'Accordion':
        output = (
          <RenderAccordion
            labels={p.labels}
            multiple={p.multiple}
            panels={children as ReactNode[]}
            initial={presentation.current[instance]?.expanded}
            onExpanded={(expanded) => {
              presentation.current[instance] = {
                ...presentation.current[instance],
                expanded,
              };
            }}
          />
        );
        break;
      case 'Table':
        output = <DataTable p={p} />;
        break;
      case 'Flowchart':
        output = (
          <Fullscreen>
            <FlowView p={p} />
          </Fullscreen>
        );
        break;
      case 'Diagram':
        output = (
          <Fullscreen>
            <Diagram source={p.chart} />
          </Fullscreen>
        );
        break;
      case 'Map':
        output = (
          <Fullscreen>
            <MapView p={p} />
          </Fullscreen>
        );
        break;
      case 'Image':
        output = (
          <div className={p.variant === 'horizontal' ? 'horizontal' : 'render-grid'}>
            {p.images.map((image: Props, i: number) => (
              <Fullscreen key={image.src ?? i}>
                <ImageView image={image} />
              </Fullscreen>
            ))}
          </div>
        );
        break;
      case 'CodeBlock':
        output = <CodeView code={p.code} language={p.language} />;
        break;
      case 'Callout':
        output = (
          <div className={`callout ${p.tone ?? ''}`}>
            {p.icon ? <Icon name={p.icon} size={16} /> : <span className="callout-bar" />}
            <div>
              {p.title && <strong>{p.title}</strong>}
              <p>{p.content}</p>
            </div>
          </div>
        );
        break;
      case 'Icon':
        output = <Icon name={p.name} size={Math.min(p.size ?? 22, 64)} label={p.label} />;
        break;
      case 'TagList':
        output = (
          <div className="row wrap tag-list">
            {p.tags.map((t: unknown, i: number) => (
              <span key={i} className="badge">
                {String(t)}
              </span>
            ))}
          </div>
        );
        break;
      case 'List':
        output = (
          <ul className={`render-list ${p.style ?? 'bullet'}`}>
            {p.items.map((t: unknown, i: number) => (
              <li key={i}>{String(t)}</li>
            ))}
          </ul>
        );
        break;
      case 'ListBlock':
        output = (
          <div className="list-block">
            {p.items.map((item: Props, i: number) => (
              <div className="list-row" key={i}>
                <div>
                  <strong>{item.label}</strong>
                  <p className="muted">{item.description}</p>
                </div>
                <span>{String(item.value ?? '')}</span>
              </div>
            ))}
          </div>
        );
        break;
      case 'Timeline':
        output = (
          <div className="timeline">
            {p.steps.map((step: Props, i: number) => (
              <div key={i}>
                <span className={'timeline-dot ' + step.status} />
                <strong>{step.title ?? step.label}</strong>
                <p className="muted">{step.description ?? step.detail}</p>
                {step.image && (
                  <Fullscreen>
                    <ImageView image={step.image} />
                  </Fullscreen>
                )}
              </div>
            ))}
          </div>
        );
        break;
      case 'Progress':
        output = (
          <div className="render-progress">
            {p.label && <strong>{p.label}</strong>}
            <ProgressTrack value={p.value} label={p.label} />
            <small>{p.value}%</small>
          </div>
        );
        break;
      case 'Rating':
        output = (
          <div className="row rating" aria-label={`评分 ${p.value}，满分 5`}>
            {Array.from({ length: 5 }, (_, i) => (
              <span className="rating-star" key={i}>
                <Star />
                <span
                  style={{
                    width: `${Math.min(1, Math.max(0, p.value - i)) * 100}%`,
                  }}
                >
                  <Star />
                </span>
              </span>
            ))}
            <strong>{Number(p.value).toFixed(1)}</strong>
            {p.count != null && <small className="muted">({p.count})</small>}
          </div>
        );
        break;
      case 'MetricGrid':
      case 'KPIGrid':
        output = (
          <section>
            {p.title && <h3>{p.title}</h3>}
            <div className="render-grid metric-grid">
              {p.metrics.map((m: Props, i: number) => (
                <div className="metric" key={i}>
                  <span className="muted">{m.label}</span>
                  <strong>{formatValue(m.value, m.format)}</strong>
                  {m.change != null && (
                    <small className={m.change >= 0 ? 'positive' : 'negative'}>
                      {m.change > 0 ? '+' : ''}
                      {m.change}%
                    </small>
                  )}
                  {m.trend && <Sparkline values={m.trend} />}
                </div>
              ))}
            </div>
          </section>
        );
        break;
      case 'ComparisonList':
      case 'MeterList':
        output = (
          <section className="stack">
            {p.title && <h3>{p.title}</h3>}
            {p.items.map((item: Props, i: number) =>
              el.type === 'MeterList' ? (
                <div className="render-progress meter-item" key={i}>
                  <div className="row spread">
                    <strong>{item.label}</strong>
                    <small className="muted">
                      {formatValue(item.value, item.format)} /{' '}
                      {formatValue(item.max ?? 100, item.format)}
                    </small>
                  </div>
                  <ProgressTrack
                    value={item.value}
                    min={item.min ?? 0}
                    max={item.max ?? 100}
                    label={item.label}
                    tone={item.tone}
                  />
                  {item.description && <small className="muted">{item.description}</small>}
                </div>
              ) : (
                <div className="comparison-row" key={i}>
                  <span className="comparison-index">{i + 1}</span>
                  <div className="grow">
                    <strong>{item.label}</strong>
                    {item.note && <p className="muted">{item.note}</p>}
                  </div>
                  <div className="comparison-value">
                    <strong>{formatValue(item.value, item.format)}</strong>
                    {item.change != null && (
                      <p
                        className={
                          item.change > 0 ? 'positive' : item.change < 0 ? 'negative' : 'muted'
                        }
                      >
                        <small>
                          {item.change > 0 ? '+' : ''}
                          {item.change}%
                        </small>
                      </p>
                    )}
                  </div>
                </div>
              ),
            )}
          </section>
        );
        break;
      case 'RecordCard':
        output = (
          <Card className={`render-card record-card ${p.variant ?? ''}`}>
            {p.image && (
              <Fullscreen>
                <ImageView image={p.image} />
              </Fullscreen>
            )}
            {p.status && (
              <span className={`badge ${p.status.tone ?? 'accent'}`}>{p.status.label}</span>
            )}
            {p.eyebrow && <small className="muted">{p.eyebrow}</small>}
            {p.title && <h3>{p.title}</h3>}
            {p.description && <p className="muted">{p.description}</p>}
            <div className="render-grid record-grid">
              {p.fields?.map((f: Props, i: number) => (
                <div className="metric" key={i}>
                  <span className="muted">{f.label}</span>
                  <strong>{formatValue(f.value, f.format)}</strong>
                </div>
              ))}
            </div>
            {children}
          </Card>
        );
        break;
      case 'ProductCard':
        output = (
          <Card className={`render-card product-card ${depth > 0 ? 'nested' : ''}`}>
            {p.image && (
              <Fullscreen>
                <ImageView image={p.image} />
              </Fullscreen>
            )}
            {p.badge && <span className={`badge ${p.badgeTone ?? 'accent'}`}>{p.badge}</span>}
            <h3>{p.name}</h3>
            {p.meta && <p className="muted product-meta">{p.meta}</p>}
            {p.description && <p className="muted">{p.description}</p>}
            <div className="product-price">
              <strong className="metric-value">
                {p.amount != null
                  ? formatValue(p.amount, {
                      style: 'currency',
                      currency: p.currency ?? 'USD',
                    })
                  : p.price}
              </strong>
              {p.rating != null && (
                <span className="product-rating">
                  <Star size={12} />
                  <strong>{Number(p.rating).toFixed(1)}</strong>
                  {p.reviewCount != null && <span className="muted">({p.reviewCount})</span>}
                </span>
              )}
            </div>
            {children}
          </Card>
        );
        break;
      case 'ItemCard': {
        const content = (
          <Card className={'render-card item-card ' + (p.selected ? 'selected' : '')}>
            <div className="row">
              {slot('leading')}
              <div className="grow">{children}</div>
              {slot('trailing')}
            </div>
          </Card>
        );
        const interactive = (ids: string[]): boolean =>
          ids.some((key) => {
            const child = doc.spec.elements[key];
            return (
              Object.keys(child.on ?? {}).length > 0 ||
              Boolean((child.props.value as Props)?.$bindState) ||
              [
                'Button',
                'Followup',
                'Tabs',
                'Accordion',
                'Image',
                'Map',
                'ItemCard',
                'GeneratedComposition',
              ].includes(child.type) ||
              interactive([...child.children, ...Object.values(child.slots ?? {}).flat()])
            );
          });
        const hasControls = interactive([...el.children, ...Object.values(el.slots ?? {}).flat()]);
        output =
          el.on?.press && !hasControls ? (
            <button
              type="button"
              className="item-card-action"
              aria-pressed={Boolean(p.selected)}
              disabled={locked}
              onClick={() => trigger('press')}
            >
              {content}
            </button>
          ) : el.on?.press ? (
            <div className="row">
              {content}
              <Button
                isIconOnly
                isDisabled={locked}
                variant="tertiary"
                aria-label="打开项目"
                onPress={() => trigger('press')}
              >
                <ChevronRight size={16} />
              </Button>
            </div>
          ) : (
            content
          );
        break;
      }
      case 'Followup':
        if (hideFollowups) return null;
        output = (
          <div className="followups">
            {p.prompts.map((prompt: string, i: number) => (
              <Button
                variant="secondary"
                isDisabled={locked}
                key={i}
                onPress={() => {
                  bind(el, prompt);
                  trigger('press');
                }}
              >
                {prompt}
                <ArrowUpRight size={14} />
              </Button>
            ))}
          </div>
        );
        break;
      case 'GeneratedComposition':
        output = <Scene p={p}>{children}</Scene>;
        break;
      default:
        output = <ChartView type={el.type} p={p} />;
    }
    return (
      <div
        key={instance}
        data-component={el.type}
        data-surface-depth={depth}
        data-instance={instance}
        className="render-node"
      >
        {hosted ? <Card className="render-card auto-surface">{output}</Card> : output}
      </div>
    );
  }
  return (
    <div
      className={'renderer ' + (disabled ? 'submitted' : '')}
      aria-busy={busy}
      onPointerDownCapture={prepareRenderPress}
      onKeyDownCapture={prepareRenderPress}
    >
      {node(doc.spec.root)}
      {busy && (
        <div className="row muted">
          <Spinner size="sm" />
          正在提交…
        </div>
      )}
      {notice && (
        <p role="status" className="callout">
          {notice}
        </p>
      )}
      {disabled && (
        <small className="muted">
          <Check size={12} /> {readOnlyNote ?? '已提交'}
        </small>
      )}
    </div>
  );
}
function Choice({
  type,
  p,
  disabled,
  onChange,
  onBlur,
}: {
  type: string;
  p: Props;
  disabled: boolean;
  onChange: (v: Value) => void;
  onBlur: () => void;
}) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const selected = Array.isArray(p.value) ? p.value : [p.value];
  const multiple = type === 'CheckboxGroup' || Boolean(p.multiple);
  const options = (
    <div
      className={
        type === 'Radio'
          ? 'stack compact'
          : `option-grid ${type === 'ToggleGroup' ? 'toggle-grid' : ''}`
      }
    >
      {p.options
        .filter((o: Props) => !query || o.label.toLowerCase().includes(query.toLowerCase()))
        .map((o: Props) =>
          type === 'Radio' ? (
            <label key={o.value} className="choice">
              <input
                type="radio"
                name={p.label}
                checked={p.value === o.value}
                disabled={disabled || o.disabled}
                onBlur={onBlur}
                onChange={() => onChange(o.value)}
              />
              <span>
                {o.label}
                <small>{o.description}</small>
              </span>
            </label>
          ) : (
            <Button
              key={o.value}
              isDisabled={disabled || o.disabled}
              variant="tertiary"
              className={'option-card ' + (type === 'ToggleGroup' ? 'toggle-option' : '')}
              aria-pressed={selected.includes(o.value)}
              onPress={() => {
                onChange(
                  multiple
                    ? selected.includes(o.value)
                      ? selected.filter((v: Value) => v !== o.value)
                      : [...selected, o.value]
                    : selected.includes(o.value)
                      ? []
                      : [o.value],
                );
                if (type === 'ComboBox' && !multiple) {
                  setOpen(false);
                  setQuery('');
                }
              }}
            >
              {type !== 'ToggleGroup' && (
                <span className="option-check">
                  {selected.includes(o.value) && <Check size={14} />}
                </span>
              )}
              <span className="grow">
                {o.label}
                {o.description && <small>{o.description}</small>}
              </span>
            </Button>
          ),
        )}
    </div>
  );
  return type === 'ComboBox' ? (
    <Popover
      isOpen={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setQuery('');
          onBlur();
        }
      }}
    >
      <Button
        variant="tertiary"
        className="choice-trigger"
        isDisabled={disabled}
        aria-label={p.label}
      >
        <span>
          {p.options
            .filter((o: Props) => selected.includes(o.value))
            .map((o: Props) => o.label)
            .join('、') || '请选择'}
        </span>
        <ChevronDown size={16} />
      </Button>
      <Popover.Content className="renderer render-overlay choice-popover">
        <Popover.Dialog>
          <div className="stack">
            <h3>{p.label}</h3>
            <Input
              aria-label={'搜索' + p.label}
              placeholder="搜索选项…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {options}
          </div>
        </Popover.Dialog>
      </Popover.Content>
    </Popover>
  ) : (
    options
  );
}

function LocalTabs({
  labels,
  initial,
  panels,
  title,
  onSelected,
}: {
  labels: string[];
  initial: number;
  panels: ReactNode;
  title?: string;
  onSelected: (value: number) => void;
}) {
  const [index, setIndex] = useState(initial);
  return (
    <section className="render-tabs">
      {title && <h3>{title}</h3>}
      <div className="segmented" role="tablist" aria-label={title ?? '内容标签'}>
        {labels.map((label, i) => (
          <button
            type="button"
            role="tab"
            aria-selected={i === index}
            className="button button--tertiary"
            tabIndex={i === index ? 0 : -1}
            key={i}
            onClick={() => {
              setIndex(i);
              onSelected(i);
            }}
            onKeyDown={(event) => {
              const next =
                event.key === 'ArrowRight'
                  ? (i + 1) % labels.length
                  : event.key === 'ArrowLeft'
                    ? (i + labels.length - 1) % labels.length
                    : event.key === 'Home'
                      ? 0
                      : event.key === 'End'
                        ? labels.length - 1
                        : -1;
              if (next >= 0) {
                event.preventDefault();
                setIndex(next);
                onSelected(next);
                event.currentTarget.parentElement
                  ?.querySelectorAll<HTMLButtonElement>('[role=tab]')
                  [next]?.focus();
              }
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <motion.div
        className="tab-panel"
        role="tabpanel"
        key={index}
        initial={{ opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        transition={soft(0.2)}
      >
        {(panels as ReactNode[])?.[index]}
      </motion.div>
    </section>
  );
}
function DataTable({ p }: { p: Props }) {
  const [filter, setFilter] = useState(''),
    [sort, setSort] = useState({ key: '', asc: true });
  let rows: Props[] = (p.rows ?? []).filter(
    (r: Props) =>
      !filter || Object.values(r).join(' ').toLowerCase().includes(filter.toLowerCase()),
  );
  if (sort.key)
    rows = [...rows].sort(
      (a, b) =>
        (typeof a[sort.key] === 'number'
          ? a[sort.key] - b[sort.key]
          : String(a[sort.key]).localeCompare(String(b[sort.key]))) * (sort.asc ? 1 : -1),
    );
  return (
    <section>
      {p.title && <h3>{p.title}</h3>}
      {p.filterable && (
        <Input
          aria-label="筛选表格"
          placeholder="筛选表格…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      )}
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              {p.columns.map((c: Props) => (
                <th key={c.key}>
                  <Button
                    size="sm"
                    variant="tertiary"
                    onPress={() =>
                      setSort({
                        key: c.key,
                        asc: sort.key === c.key ? !sort.asc : true,
                      })
                    }
                  >
                    {c.label}
                    {sort.key === c.key && (
                      <Icon name={sort.asc ? 'arrow-up' : 'arrow-down'} size={14} />
                    )}
                  </Button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                {p.columns.map((c: Props) => (
                  <td key={c.key}>{String(r[c.key] ?? '—')}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length && <p className="empty">没有匹配的数据</p>}
      </div>
    </section>
  );
}
function Sparkline({ values }: { values: number[] }) {
  // useId contains colons; strip them so the id is safe inside url(#…).
  const id = useId().replace(/:/g, '');
  // Draws once the enclosing message, card or page has finished arriving.
  const entered = useEntered();
  const min = Math.min(...values),
    max = Math.max(...values);
  const points = values.map(
    (n, i) =>
      `${(i * 180) / Math.max(1, values.length - 1)},${30 - ((n - min) / Math.max(1, max - min)) * 26}`,
  );
  return (
    <svg viewBox="0 0 180 35" className="sparkline">
      <defs>
        <linearGradient id={id + 'line'} x1="0" x2="1">
          <stop offset="0" stopColor="var(--brand)" stopOpacity="0.55" />
          <stop offset="1" stopColor="var(--brand)" />
        </linearGradient>
        <linearGradient id={id + 'area'} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="var(--brand)" stopOpacity="0.28" />
          <stop offset="1" stopColor="var(--brand)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <motion.polygon
        points={`0,35 ${points.join(' ')} 180,35`}
        fill={`url(#${id}area)`}
        initial={{ opacity: 0 }}
        animate={{ opacity: entered ? 1 : 0 }}
        transition={soft(0.65, 0.2)}
      />
      <motion.polyline
        points={points.join(' ')}
        fill="none"
        stroke={`url(#${id}line)`}
        strokeWidth={2.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        className="sparkline-line"
        initial={{ pathLength: 0 }}
        animate={{ pathLength: entered ? 1 : 0 }}
        transition={soft(0.65)}
      />
    </svg>
  );
}

class RenderBoundary extends Component<{ children: ReactNode }, { error: string }> {
  state = { error: '' };
  static getDerivedStateFromError(error: Error) {
    return { error: error.message };
  }
  render() {
    return this.state.error ? (
      <div role="alert" className="callout danger">
        无法显示卡片，请让 Bot 重新发送。
      </div>
    ) : (
      this.props.children
    );
  }
}

function encodeKey(value: unknown) {
  return btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(value))));
}
