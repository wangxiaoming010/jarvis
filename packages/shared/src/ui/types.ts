export type Value = null | boolean | number | string | Value[] | { [key: string]: Value };
export type State = {
  data: Record<string, Value>;
  form: Record<string, Value>;
  ui: Record<string, Value>;
  /** Formulas in a document; their values while rendering (see calc.ts). */
  computed?: Record<string, Value>;
};
export type Binding = {
  action: 'dispatch' | 'submitForm' | 'setState';
  params: Record<string, Value>;
};
export type ElementSpec = {
  type: string;
  props: Record<string, Value>;
  children: string[];
  slots?: Record<string, string[]>;
  visible?: Value;
  on?: Record<string, Binding>;
  repeat?: { statePath: string; key: string };
};
export type RenderDocument = {
  protocolVersion: 'opsique-ui/0.1';
  context: { threadId: string; viewId: string; revision: number };
  spec: { root: string; elements: Record<string, ElementSpec> };
  state: State;
};
export type ActionEnvelope = {
  requestId: string;
  context: RenderDocument['context'];
  componentId: string;
  instanceId: string;
  event: string;
  action: 'dispatch' | 'submitForm';
  params: Record<string, Value>;
};
export type Scope = { item?: Value; index?: number; instance: string };
