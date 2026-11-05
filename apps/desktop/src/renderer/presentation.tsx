import { useEffect, useId, useRef, useState, type ReactNode, type SyntheticEvent } from 'react';
import { Button } from '@heroui/react';
import { AnimatePresence, motion } from 'motion/react';
import { soft, useEntered } from './motion';
import { ChevronDown } from 'lucide-react';
import type { Props } from './charts';

export function CodeView({ code, language = '代码' }: { code: string; language?: string }) {
  const [status, setStatus] = useState('复制');
  useEffect(() => setStatus('复制'), [code]);
  return (
    <div className="code-frame">
      <div className="row spread">
        <small className="muted">{language}</small>
        <Button
          variant="secondary"
          aria-label={status === '已复制' ? '代码已复制' : '复制代码'}
          onPress={async () => {
            try {
              await navigator.clipboard.writeText(code);
              setStatus('已复制');
            } catch {
              setStatus('复制失败');
            }
          }}
        >
          {status}
        </Button>
      </div>
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  );
}

export function prepareRenderPress(event: SyntheticEvent<HTMLElement>) {
  const control = (event.target as HTMLElement).closest<HTMLElement>('button, .choice, summary');
  if (!control) return;
  const scale = 1 - Math.min(0.06, 4.5 / Math.max(control.getBoundingClientRect().width, 1));
  control.style.setProperty('--render-press-scale', String(scale));
}

export function ProgressTrack({
  value,
  label,
  min = 0,
  max = 100,
  tone,
}: {
  value: number;
  label?: string;
  min?: number;
  max?: number;
  tone?: string;
}) {
  // Fills once the enclosing message, card or page has finished arriving.
  const entered = useEntered();
  const percent = Math.max(0, Math.min(100, ((value - min) / Math.max(max - min, 1)) * 100));
  return (
    <div
      className="progress-track"
      role="progressbar"
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
    >
      <motion.div
        className="progress-fill"
        initial={{ scaleX: 0 }}
        animate={{ scaleX: entered ? 1 : 0 }}
        transition={soft(0.65)}
        style={{
          transformOrigin: 'left center',
          width: `${percent}%`,
          backgroundColor: tone ? `var(--render-${tone}, var(--brand))` : undefined,
        }}
      />
    </div>
  );
}

export function StepPage({ index, children }: { index: number; children: ReactNode }) {
  const previous = useRef({ index, direction: 'forward' });
  if (index !== previous.current.index)
    previous.current = {
      index,
      direction: index < previous.current.index ? 'backward' : 'forward',
    };
  const direction = previous.current.direction;
  // Commit the direction before the previous page disappears, as in StepsComponent.

  // iOS Steps: forward pages enter from the right and leave left; backward
  // reverses. `custom` hands the latest direction to the page that is leaving.
  const offset = (dir: string) => (dir === 'backward' ? -36 : 36);
  return (
    <div style={{ overflow: 'hidden', position: 'relative' }}>
      <AnimatePresence mode="popLayout" initial={false} custom={direction}>
        <motion.div
          className="step-page"
          key={index}
          data-direction={direction}
          custom={direction}
          variants={{
            enter: (dir: string) => ({ opacity: 0, x: offset(dir) }),
            center: { opacity: 1, x: 0 },
            leave: (dir: string) => ({ opacity: 0, x: -offset(dir) }),
          }}
          initial="enter"
          animate="center"
          exit="leave"
          transition={soft(0.35)}
        >
          {children}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

export function RenderAccordion({
  labels,
  multiple,
  panels,
  initial = [],
  onExpanded,
}: {
  labels: string[];
  multiple?: boolean;
  panels: ReactNode[];
  initial?: number[];
  onExpanded: (value: number[]) => void;
}) {
  const [expanded, setExpanded] = useState(initial);
  const prefix = useId();
  return (
    <div className="render-accordion">
      {labels.map((label, index) => {
        const open = expanded.includes(index),
          id = `${prefix}-${index}`;
        return (
          <section className="accordion-item" key={index}>
            <Button
              variant="tertiary"
              className="accordion-trigger"
              aria-expanded={open}
              aria-controls={id}
              onPress={() => {
                const next = open
                  ? expanded.filter((i) => i !== index)
                  : [...(multiple ? expanded : []), index];
                setExpanded(next);
                onExpanded(next);
              }}
            >
              {label}
              <ChevronDown size={14} />
            </Button>
            <div
              className="accordion-body"
              data-open={open}
              inert={!open}
              aria-hidden={!open}
              id={id}
            >
              <div>
                <div className="accordion-body-content">{panels[index]}</div>
              </div>
            </div>
          </section>
        );
      })}
    </div>
  );
}

export function formatValue(value: unknown, format?: Props): string {
  if (typeof value !== 'number' || !format)
    return value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  let divisor = 1,
    suffix = '';
  if (format.compact && format.style !== 'percent') {
    for (const [limit, unit] of [
      [1e12, 'T'],
      [1e9, 'B'],
      [1e6, 'M'],
      [1e3, 'K'],
    ] as const) {
      if (Math.abs(value) >= limit) {
        divisor = limit;
        suffix = unit;
        break;
      }
    }
  }
  return (
    new Intl.NumberFormat('zh-CN', {
      style:
        format.style === 'currency'
          ? 'currency'
          : format.style === 'percent'
            ? 'percent'
            : 'decimal',
      currency: format.currency,
      minimumFractionDigits: format.minimumFractionDigits ?? 0,
      maximumFractionDigits: format.maximumFractionDigits ?? 2,
    }).format(value / divisor) + suffix
  );
}
