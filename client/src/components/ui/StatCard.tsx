import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

interface StatCardProps {
  title: string;
  value: string | number;
  icon: LucideIcon;
  trend?: string;
  trendUp?: boolean;
  color?: 'brand' | 'blue' | 'green' | 'orange' | 'purple';
}

const colorMap = {
  brand: 'bg-brand-50 text-brand-600 dark:bg-brand-950/50 dark:text-brand-400',
  blue: 'bg-blue-50 text-blue-600 dark:bg-blue-950/50 dark:text-blue-400',
  green: 'bg-green-50 text-green-600 dark:bg-green-950/50 dark:text-green-400',
  orange: 'bg-orange-50 text-orange-600 dark:bg-orange-950/50 dark:text-orange-400',
  purple: 'bg-purple-50 text-purple-600 dark:bg-purple-950/50 dark:text-purple-400',
};

export default function StatCard({ title, value, icon: Icon, trend, trendUp, color = 'brand' }: StatCardProps) {
  return (
    <div className="card min-w-0 animate-fade-in hover:shadow-card-hover">
      <div className="flex min-w-0 items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-gray-500 dark:text-gray-400">{title}</p>
          <p className="mt-2 truncate text-xl font-bold text-gray-900 dark:text-white sm:text-2xl">{value}</p>
          {trend && (
            <p className={cn('mt-1 text-xs font-medium', trendUp ? 'text-green-600' : 'text-red-600')}>
              {trend}
            </p>
          )}
        </div>
        <div className={cn('flex h-11 w-11 items-center justify-center rounded-xl', colorMap[color])}>
          <Icon className="h-5 w-5" />
        </div>
      </div>
    </div>
  );
}
