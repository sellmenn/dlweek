import { type ReactNode } from "react";

export const glassStyle: React.CSSProperties = {
  background: "rgba(255, 255, 255, 0.04)",
  backdropFilter: "blur(20px)",
  WebkitBackdropFilter: "blur(20px)",
  boxShadow: "0 8px 28px rgba(0,0,0,0.6)",
  border: "1.5px solid rgba(255,255,255,0.12)",
};

interface GlassCardProps {
  children: ReactNode;
  className?: string;
  onClick?: () => void;
}

export function GlassCard({
  children,
  className = "",
  onClick,
}: GlassCardProps) {
  return (
    <div
      style={glassStyle}
      onClick={onClick}
      className={`
        rounded-2xl
        flex flex-col justify-between
        text-white
        ${onClick ? "cursor-pointer hover:brightness-110 transition-all duration-200" : ""}
        ${className}
      `}
    >
      {children}
    </div>
  );
}
