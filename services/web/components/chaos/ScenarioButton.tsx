'use client';

import type { ReactNode } from 'react';
import { Card, CardContent } from '../ui/card';
import { cn } from '../../lib/utils';

interface ScenarioButtonProps {
  icon: ReactNode;
  title: string;
  description: string;
  variant?: 'default' | 'danger';
  onClick: () => void;
}

export default function ScenarioButton({
  icon,
  title,
  description,
  variant = 'default',
  onClick,
}: ScenarioButtonProps) {
  return (
    <Card
      role="button"
      tabIndex={0}
      className={cn(
        'cursor-pointer select-none transition-all hover:bg-accent active:scale-[0.97]',
        variant === 'danger' && 'border-destructive/50 hover:bg-destructive/10',
      )}
      onClick={onClick}
      onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && onClick()}
    >
      <CardContent className="p-4 flex flex-col gap-2">
        <div className="w-8 h-8 flex items-center justify-center">{icon}</div>
        <p className="font-semibold text-sm text-foreground leading-tight">{title}</p>
        <p className="text-xs text-muted-foreground leading-relaxed">{description}</p>
      </CardContent>
    </Card>
  );
}
