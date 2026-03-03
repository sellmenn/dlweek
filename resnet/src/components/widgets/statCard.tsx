import { GlassCard } from "./glassCard";

interface StatCardProps {
  label: string;
  value: string | number;
  delta?: string;
  deltaSign?: "positive" | "negative" | "neutral";
  align?: "left" | "right";
  className?: string;
}

const deltaColors: Record<string, string> = {
  neutral: "text-gray-400",
};

export function StatCard({
  label,
  value,
  delta,
  deltaSign = "neutral",
  align = "left",
  className = "",
}: StatCardProps) {
  return (
    <GlassCard className={`p-5 min-w-[130px] min-h-[140px] ${className}`}>
      {/* Top-left label */}
      <p className="text-[10px] text-white/35 uppercase tracking-[3px] leading-tight self-start">
        {label}
      </p>

      {/* Bottom value + optional delta, aligned left or right */}
      <div
        className={`flex flex-col ${align === "right" ? "items-end" : "items-start"}`}
      >
        <p className="text-5xl font-bold leading-none">{value}</p>
        {delta && (
          <p className={`text-[11px] mt-1 ${deltaColors[deltaSign]}`}>
            {delta}
          </p>
        )}
      </div>
    </GlassCard>
  );
}
