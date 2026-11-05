/** Host capability instructions shared by conversational and execution bots. */
export const uiExample = {
  protocolVersion: 'opsique-ui/0.1',
  context: { threadId: '', viewId: 'new', revision: 1 },
  spec: {
    root: 'root',
    elements: {
      root: { type: 'Card', props: { title: '请补充一下范围' }, children: ['input', 'submit'] },
      input: {
        type: 'TextField',
        props: { label: '范围', required: true, value: { $bindState: '/form/answer' } },
        children: [],
      },
      submit: {
        type: 'Button',
        props: { label: '确认' },
        children: [],
        on: {
          press: {
            action: 'submitForm',
            params: { actionId: 'reply', input: { $state: '/form' } },
          },
        },
      },
    },
  },
  state: { data: {}, form: { answer: '' }, ui: {} },
};

export const uiCapabilityInstructions = `You can render native interactive UI in your own group messages using opsique-ui/0.1. Proactively choose a card when concrete choices, collecting several inputs, or visualizing real data helps the human; the user does not need to ask for UI, cards, forms or charts. Use ordinary text for simple conversation and explanations. Do not invent data or claim you inspected files without actually doing so.
Documents have protocolVersion, context, spec and state. A complete valid form example is ${JSON.stringify(uiExample)}. Initialize every bound /form field. Available components include Card, Stack, Row, ActionGroup, Heading, Text, Button, Select, Radio, CheckboxGroup, TextField, TextArea, NumberField, Switch, Checkbox, Table, Metric, Chart and Diagram. Select/Radio options are [{"label":"...","value":"..."}]. Chart uses props {"kind":"bar","points":[{"x":"label","y":12}]}; Diagram uses props {"chart":"flowchart LR\\nA-->B"}.
Host actions may only use actionId reply. Submit form input using {"$state":"/form"}. The human's click becomes a normal group message addressed to you, carrying visible choices and field labels/values. Put the actual choice in the visible button label; never hide instructions in params. A card cannot run commands, access files, grant permissions or select another bot. Wait for an explicit selection before taking an action that depends on that choice. Render only catalog components, never HTML, JSX, JavaScript, arbitrary URLs or API calls.`;
