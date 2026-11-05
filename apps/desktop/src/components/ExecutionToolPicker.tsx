import type { Provider } from '@openbot/shared';
import { Check } from 'lucide-react';

export function ExecutionToolPicker({
  value,
  onChange,
  disabled = false,
}: {
  value: Provider;
  onChange: (provider: Provider) => void;
  disabled?: boolean;
}) {
  return (
    <fieldset className="execution-tool-picker" disabled={disabled}>
      <legend>执行工具</legend>
      <div className="execution-tool-options">
        {(
          [
            { id: 'codex', name: 'Codex', brand: 'OpenAI', logo: '/logos/codex.svg' },
            {
              id: 'claude-code',
              name: 'Claude Code',
              brand: 'Anthropic',
              logo: '/logos/claude.svg',
            },
          ] as const
        ).map((tool) => (
          <label className="execution-tool-card" key={tool.id}>
            <input
              type="radio"
              name="execution-tool"
              aria-label={tool.name}
              value={tool.id}
              checked={value === tool.id}
              onChange={() => onChange(tool.id)}
            />
            <span className="execution-tool-content">
              <img src={tool.logo} alt="" aria-hidden="true" />
              <strong>{tool.name}</strong>
              <small>{tool.brand}</small>
              <span className="execution-tool-check" aria-hidden="true">
                {value === tool.id && <Check size={13} />}
              </span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
