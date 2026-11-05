import { icons, Sparkles, type LucideIcon } from 'lucide-react';
export function Icon({ name, size = 20, label }: { name: string; size?: number; label?: string }) {
  const key = name
    .split('-')
    .map((v) => v.charAt(0).toUpperCase() + v.slice(1))
    .join('');
  const Component = (icons as Record<string, LucideIcon>)[key] ?? Sparkles;
  return <Component size={size} aria-label={label} aria-hidden={!label} />;
}
