import type { PropsWithChildren, ReactNode } from 'react';

type PanelProps = PropsWithChildren<{
  eyebrow?: string;
  title: string;
  action?: ReactNode;
  className?: string;
}>;

export function Panel({ eyebrow, title, action, className = '', children }: PanelProps) {
  return (
    <section className={`panel ${className}`.trim()}>
      <div className="panel__heading">
        <div>
          {eyebrow ? <span className="eyebrow">{eyebrow}</span> : null}
          <h2>{title}</h2>
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}
