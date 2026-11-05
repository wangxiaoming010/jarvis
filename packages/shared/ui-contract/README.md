# OpenBot UI contract 0.1

OpenBot retains the `opsique-ui/0.1` wire format for compatibility with its adapted renderer.
The current component/property allowlist is [catalog.json](catalog.json); the human-readable
index is [COMPONENTS.md](COMPONENTS.md). See the [renderer provenance](../../../apps/desktop/src/renderer/PROVENANCE.md).

Models describe data and components, never executable JavaScript or HTML. The host validates
the document and controls every action. This directory contains protocol resources, not
an independent application or mobile client.

## Document

`document.schema.json` is the API document schema. `spec.schema.json` defines the nested tree.

```json
{
  "protocolVersion": "opsique-ui/0.1",
  "context": { "threadId": "", "viewId": "unique-view", "revision": 1 },
  "spec": { "root": "root", "elements": {} },
  "state": { "data": {}, "form": {}, "ui": {} }
}
```

The snippet illustrates the envelope; a valid spec must have a reachable root component.
`threadId` is empty outside a conversation; `viewId` identifies a render instance, independent
of the screen; `revision` is an increasing positive integer. Unsupported versions are rejected.
Every element must be reachable, references must exist, cycles are rejected. Current budgets:
256 elements, depth 16, 2,048 graph visits (plus runtime repetition budgets).
Unknown components/properties/events/actions fail validation before replacing visible content.
Canonical fixtures with `name`/`title` metadata are gallery resources, not API documents.

## State and interaction

- `/data`: server-owned display data.
- `/form`: client-owned draft until a submission response explicitly acknowledges/replaces it.
- `/ui`: local transient state (filter, expansion etc.).
- `{ "$state": "/data/name" }` reads a value.
- `{ "$bindState": "/form/report/name" }` reads and writes an input property allowed by Catalog.
- Local `setState` writes only `/form` or `/ui`, never performs a network request.
- `visible`, `$and`, `$or`, `eq`, `neq`, `not`, `$item`, `$index` follow the restricted schema.
- `repeat` repeats a container's children with stable instance IDs derived from item keys.
- `submitForm` validates required/maxLength/options locally, then emits resolved params and input.
- `dispatch` emits a host action. The host resolves `actionId` via an allowlist; spec cannot choose URLs.

`action.schema.json` defines the emitted action: requestId, context, componentId, instanceId,
event, action, resolved params. `requestId` is an idempotency key: retry the same invocation
with the same ID and body. A new user submission receives a new ID. An uncertain transport
result is `unknown`; never silently replay a potentially accepted operation.

## Computed values (optional `calc` capability)

`state.computed` maps names to formulas over the other state, so a slider or field can drive
metrics, text, visibility and charts without another model turn. The evaluator is implemented in `packages/shared/src/ui/calc.ts` and checked against
`conformance/calc.json`.

```json
"state": {
  "data": {}, "form": { "amount": 100, "rate": 3.5, "years": 30 }, "ui": {},
  "computed": {
    "payment": "pmt(form.rate / 1200, form.years * 12, form.amount * 10000)",
    "paymentText": "currency(payment)",
    "curve": { "range": [0, "form.years"], "y": "round(payment * 12 * t / 10000, 1)" }
  }
}
```

- Read with `{ "$state": "/computed/paymentText" }` anywhere a `$state` read is allowed,
  including `visible` conditions and action params. Computed values are read-only:
  `$bindState` and `setState` cannot target `/computed`.
- A formula has numbers, `'strings'`, `true`, `false`, `+ - * / % ^`, comparisons, `&& || !`,
  `cond ? a : b`, parentheses, references to `form.*`, `data.*`, `ui.*` (initialized in the
  document) and other computed names (no cycles). Functions: `min max sum avg count has round
floor ceil abs sqrt pow ln log10 exp clamp if pmt`, plus the formatting functions `fixed number
currency percent`. Formatting is locale independent (`,` thousands, `.` decimals; `percent`
  takes a ratio).
- Any input can drive formulas. Select and Radio values are strings, Switch and Checkbox values
  booleans, CheckboxGroup/ToggleGroup/multiple ComboBox values string lists (`count(list)`,
  `has(list, value)`; `sum avg min max` also accept lists). A number written as text in state
  (`"1200"`, `"12,000"`, `"-3.5"`) reads as a number, and `==` treats `2024` and `"2024"` as equal;
  text with leading zeros (`"00123"`) stays text.
- A series `{ "range": [from, to, step?], "x"?: formula, "y": formula }` or with
  `"series": { "label": formula }` (1–6 lines) yields Chart points; `t` is the current range
  value, `x` is always a string, and points whose `y` is not a finite number are left out.
- Limits: 48 names, 400 characters per formula, nesting depth 32, 500 points per series and
  2000 in total. Invalid formulas reject the whole document; a formula that fails at runtime
  (division by zero, `sqrt(-1)`) evaluates to `null` and renders as "—".

## OpenBot integration

- Publish a validated card: `POST /api/groups/:id/cards` with `{botId, document, replyTo?}`.
- Submit an action: `POST /api/cards/:messageId/actions` with an ActionEnvelope.
- Requests require the local client's bearer token.
- The host permits only its predefined `reply` and generated `choose_bots` actions.
  A document cannot select an arbitrary URL, command or execution target.
- Submissions validate membership, revision, component, instance, bindings and form fields.
  Repeated request IDs are idempotent; stale or already submitted cards are rejected.
- Submitted form state is persisted. Frontend drafts can be restored until submission.

The main Bot and local workers receive the shared capability instructions from
`packages/shared/src/ui/prompt.ts` and `apps/bridge/src/instructions.ts`.
Runtime prompt sources and responsibilities are listed in [the prompt reference](../../../docs/prompts.md).

Charts use ECharts; diagrams use Mermaid with restricted rendering and sanitization.
Maps are currently disabled, with supplied places still displayed as text. No private
map service is configured by default. Example media URLs remain subject to the host's
content security policy and the external provider's availability.

## Examples and validation

Canonical gallery examples live in [fixtures/](fixtures/). Their optional `name` and `title`
metadata is not part of the API envelope; supply `protocolVersion` and `context` when
turning a gallery spec into a card. Formula cases are in [conformance/calc.json](conformance/calc.json).

After editing schemas or the catalog, run:

```sh
npm run generate:ui
npm test
npm run build
npm run test:e2e
```

Validation and formula evaluation live in `packages/shared/src/ui/`; rendering lives in
`apps/desktop/src/renderer/`. The production renderer can also be checked without model
calls using `node --import tsx scripts/smoke/ui.mjs` after building the frontend.
