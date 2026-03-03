import { GlassCard } from "./glassCard";
import type { ReactNode } from "react";

interface SectionCardProps {
  title: string;
  children: ReactNode;
  className?: string;
  action?: ReactNode;
}

export function SectionCard({
  title,
  children,
  className = "",
  action,
}: SectionCardProps) {
  return (
    <GlassCard className={`p-5 ${className}`}>
      {/* Top row */}
      <div className="flex items-center justify-between self-stretch">
        <p className="text-[10px] text-white/35 uppercase tracking-[3px]">
          {title}
        </p>
        {action && <div>{action}</div>}
      </div>

      {/* Body — grows to fill remaining card height */}
      <div className="flex-1 mt-3 flex flex-col justify-end">{children}</div>
    </GlassCard>
  );
}
