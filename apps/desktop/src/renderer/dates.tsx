// HeroUI date and time inputs for the protocol's string values: DatePicker
// "YYYY-MM-DD", DateRangePicker [start, end], TimeField "HH:mm". An empty or
// malformed string shows an empty field instead of throwing.
import {
  Calendar,
  DateField,
  DatePicker,
  DateRangePicker,
  Label,
  RangeCalendar,
  TimeField,
} from '@heroui/react';
import { I18nProvider } from 'react-aria-components';
import { parseDate, parseTime, type CalendarDate, type Time } from '@internationalized/date';

// The app is Chinese (html lang="zh-CN"); keep dates in that locale
// regardless of the system language.
const LOCALE = 'zh-CN';

const date = (value: unknown): CalendarDate | null => {
  try {
    return typeof value === 'string' && value ? parseDate(value) : null;
  } catch {
    return null;
  }
};
const time = (value: unknown): Time | null => {
  try {
    return typeof value === 'string' && value ? parseTime(value) : null;
  } catch {
    return null;
  }
};

type Common = {
  label: string;
  required?: boolean;
  disabled?: boolean;
  invalid?: boolean;
  onFocus: () => void;
  onBlur: () => void;
};

function FieldLabel({ label, required }: Pick<Common, 'label' | 'required'>) {
  return (
    <Label>
      {label}
      {required ? ' *' : ''}
    </Label>
  );
}

function Segments({ slot }: { slot?: 'start' | 'end' }) {
  return (
    <DateField.Input slot={slot}>
      {(segment) => <DateField.Segment segment={segment} />}
    </DateField.Input>
  );
}

/** Calendar and RangeCalendar share their parts; `C` is either namespace. */
function CalendarParts({ C }: { C: typeof Calendar | typeof RangeCalendar }) {
  return (
    <>
      <C.Header>
        <C.YearPickerTrigger>
          <C.YearPickerTriggerHeading />
          <C.YearPickerTriggerIndicator />
        </C.YearPickerTrigger>
        <C.NavButton slot="previous" />
        <C.NavButton slot="next" />
      </C.Header>
      <C.Grid>
        <C.GridHeader>{(day: string) => <C.HeaderCell>{day}</C.HeaderCell>}</C.GridHeader>
        <C.GridBody>{(day: CalendarDate) => <C.Cell date={day} />}</C.GridBody>
      </C.Grid>
      <C.YearPickerGrid>
        <C.YearPickerGridBody>
          {({ year }: { year: number }) => <C.YearPickerCell year={year} />}
        </C.YearPickerGridBody>
      </C.YearPickerGrid>
    </>
  );
}

export function DateInput({
  value,
  onChange,
  ...p
}: Common & { value: unknown; onChange: (value: string) => void }) {
  return (
    <I18nProvider locale={LOCALE}>
      <DatePicker
        aria-label={p.label}
        className="w-full"
        value={date(value)}
        onChange={(next) => onChange(next ? next.toString() : '')}
        isDisabled={p.disabled}
        isInvalid={p.invalid}
        onFocus={p.onFocus}
        onBlur={p.onBlur}
      >
        <FieldLabel {...p} />
        <DateField.Group fullWidth>
          <Segments />
          <DateField.Suffix>
            <DatePicker.Trigger>
              <DatePicker.TriggerIndicator />
            </DatePicker.Trigger>
          </DateField.Suffix>
        </DateField.Group>
        <DatePicker.Popover className="render-overlay" placement="bottom end">
          <Calendar aria-label={p.label}>
            <CalendarParts C={Calendar} />
          </Calendar>
        </DatePicker.Popover>
      </DatePicker>
    </I18nProvider>
  );
}

export function DateRangeInput({
  value,
  onChange,
  ...p
}: Common & { value: unknown; onChange: (value: [string, string]) => void }) {
  const [start, end] = Array.isArray(value) ? value : [];
  const range = date(start) && date(end) ? { start: date(start)!, end: date(end)! } : null;
  return (
    <I18nProvider locale={LOCALE}>
      <DateRangePicker
        aria-label={p.label}
        className="w-full"
        value={range}
        onChange={(next) =>
          onChange(next ? [next.start.toString(), next.end.toString()] : ['', ''])
        }
        isDisabled={p.disabled}
        isInvalid={p.invalid}
        onFocus={p.onFocus}
        onBlur={p.onBlur}
      >
        <FieldLabel {...p} />
        <DateField.Group fullWidth>
          <Segments slot="start" />
          <DateRangePicker.RangeSeparator />
          <Segments slot="end" />
          <DateField.Suffix>
            <DateRangePicker.Trigger>
              <DateRangePicker.TriggerIndicator />
            </DateRangePicker.Trigger>
          </DateField.Suffix>
        </DateField.Group>
        <DateRangePicker.Popover className="render-overlay" placement="bottom end">
          <RangeCalendar aria-label={p.label}>
            <CalendarParts C={RangeCalendar} />
          </RangeCalendar>
        </DateRangePicker.Popover>
      </DateRangePicker>
    </I18nProvider>
  );
}

export function TimeInput({
  value,
  onChange,
  ...p
}: Common & { value: unknown; onChange: (value: string) => void }) {
  return (
    <I18nProvider locale={LOCALE}>
      <TimeField
        aria-label={p.label}
        className="w-full"
        hourCycle={24}
        value={time(value)}
        onChange={(next) => onChange(next ? next.toString().slice(0, 5) : '')}
        isDisabled={p.disabled}
        isInvalid={p.invalid}
        onFocus={p.onFocus}
        onBlur={p.onBlur}
      >
        <FieldLabel {...p} />
        <TimeField.Group fullWidth>
          <TimeField.Input>{(segment) => <TimeField.Segment segment={segment} />}</TimeField.Input>
        </TimeField.Group>
      </TimeField>
    </I18nProvider>
  );
}
