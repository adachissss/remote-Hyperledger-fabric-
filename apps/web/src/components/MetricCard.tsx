import type { LucideIcon } from 'lucide-react';

type MetricCardProps = {
  label: string;
  value: string;
  detail: string;
  icon: LucideIcon;
  tone?: 'cyan' | 'amber' | 'neutral';
};

export function MetricCard({
  label,
  value,
  detail,
  icon: Icon,
  tone = 'neutral',
}: MetricCardProps) {
  return (
    <article className={`metric-card metric-card--${tone}`}>
      <div className="metric-card__header">
        <span>{label}</span>
        <Icon size={17} strokeWidth={1.7} />
      </div>
      <strong>{value}</strong>
      <p>{detail}</p>
    </article>
  );
}
