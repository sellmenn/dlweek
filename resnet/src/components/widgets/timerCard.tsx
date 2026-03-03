import { GlassCard } from "./glassCard";

interface TimerCardProps {
  elapsed: string;
  className?: string;
}

export function TimerCard({ elapsed, className = "" }: TimerCardProps) {
  return (
    <GlassCard className={`p-5 min-w-[200px] min-h-[120px] ${className}`}>
      {/* Top-left label */}
      <p className="text-[10px] text-white/35 uppercase tracking-[3px] self-start">
        Time Elapsed
      </p>

      {/* Bottom-left timer */}
      <p className="text-2xl font-mono font-bold text-white tracking-tight self-start whitespace-nowrap">
        {elapsed}
      </p>
    </GlassCard>
  );
}
