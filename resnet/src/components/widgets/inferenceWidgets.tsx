/**
 * Display widgets for inference output from /api/predict (SSE) and /api/posts.
 *
 * Exports:
 *  - CategoryScoreBar  — single category + fill bar
 *  - ClusterScorePanel — all 5 categories for one cluster
 *  - PredictProgress   — SSE streaming progress bar
 *  - PostScoreRow      — top predicted need for a single post
 */

import { Bar, BarChart, ResponsiveContainer, XAxis, YAxis } from "recharts";
import { GlassCard } from "./glassCard";
import { SectionCard } from "./sectionCard";

// ─── Types ────────────────────────────────────────────────────────────────────

export type Category =
  | "infrastructure"
  | "food"
  | "shelter"
  | "sanitation_water"
  | "medication";

export type CategoryScores = Record<Category, number>;

const CATEGORIES: Category[] = [
  "infrastructure",
  "food",
  "shelter",
  "sanitation_water",
  "medication",
];

const CATEGORY_LABELS: Record<Category, string> = {
  infrastructure:   "Infrastructure",
  food:             "Food",
  shelter:          "Shelter",
  sanitation_water: "Water / Sanitation",
  medication:       "Medication",
};


const CATEGORY_HEX: Record<Category, string> = {
  infrastructure:   "#737E0B",
  food:             "#A18E23",
  shelter:          "#FEDC57",
  sanitation_water: "#AB8F4F",
  medication:       "#676106",
};

// ─── CategoryScoreBar ─────────────────────────────────────────────────────────

interface CategoryScoreBarProps {
  category: Category;
  score: number; // 0–1
  className?: string;
}

/** Single category label + filled progress bar for a 0–1 score. */
export function CategoryScoreBar({
  category,
  score,
  className = "",
}: CategoryScoreBarProps) {
  const pct = Math.round(Math.min(Math.max(score, 0), 1) * 100);

  return (
    <div className={`flex flex-col gap-1 ${className}`}>
      <div className="flex justify-between items-baseline">
        <span className="text-[11px] text-white/60 uppercase tracking-[2px]">
          {CATEGORY_LABELS[category]}
        </span>
        <span className="text-[12px] font-semibold text-white">{pct}%</span>
      </div>
      <div className="h-1.5 w-full rounded-full bg-white/10 overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-500"
          style={{ width: `${pct}%`, backgroundColor: CATEGORY_HEX[category] }}
        />
      </div>
    </div>
  );
}

// ─── ClusterScorePanel ────────────────────────────────────────────────────────

interface ClusterScorePanelProps {
  clusterName: string;
  scores: CategoryScores;
  postCount?: number;
  className?: string;
}

/** All 5 category resource scores for one cluster (from cluster_scores[id]). */
export function ClusterScorePanel({
  clusterName,
  scores,
  postCount,
  className = "",
}: ClusterScorePanelProps) {
  const topCategory = [...CATEGORIES].sort((a, b) => scores[b] - scores[a])[0];

  return (
    <SectionCard
      title={clusterName}
      className={className}
      action={
        postCount !== undefined ? (
          <span className="text-[10px] text-white/35 uppercase tracking-[2px]">
            {postCount} posts
          </span>
        ) : undefined
      }
    >
      <div className="flex flex-col gap-2">
        <ResponsiveContainer width="100%" height={130}>
          <BarChart
            layout="vertical"
            data={CATEGORIES.map((cat) => ({
              name: CATEGORY_LABELS[cat],
              score: Math.round((scores[cat] ?? 0) * 100),
              color: CATEGORY_HEX[cat],
            }))}
            margin={{ top: 0, right: 28, left: 0, bottom: 0 }}
          >
            <XAxis type="number" domain={[0, 100]} hide />
            <YAxis
              type="category"
              dataKey="name"
              width={95}
              tick={{ fill: "rgba(255,255,255,0.6)", fontSize: 10 }}
              axisLine={false}
              tickLine={false}
            />
            <Bar
              dataKey="score"
              background={{ fill: "rgba(255,255,255,0.05)", radius: 3 }}
              shape={(props: any) => {
                const { x, y, width, height, index } = props;
                return <rect x={x} y={y} width={width} height={height} fill={CATEGORY_HEX[CATEGORIES[index]]} rx={3} />;
              }}
            />
          </BarChart>
        </ResponsiveContainer>
        <p className="text-[10px] text-white/35 uppercase tracking-[2px]">
          Top need:{" "}
          <span className="text-white/70 normal-case tracking-normal font-medium">
            {topCategory.replace("_", " ")}
          </span>
        </p>
      </div>
    </SectionCard>
  );
}

// ─── PredictProgress ──────────────────────────────────────────────────────────

interface PredictProgressProps {
  current: number;
  total: number;
  done?: boolean;
  className?: string;
}

/**
 * SSE streaming progress from /api/predict.
 * Pass `current` + `total` from progress events; set `done` on the final event.
 */
export function PredictProgress({
  current,
  total,
  done = false,
  className = "",
}: PredictProgressProps) {
  const pct = total > 0 ? Math.round((current / total) * 100) : 0;

  return (
    <GlassCard className={`p-5 flex flex-col gap-3 ${className}`}>
      <div className="flex items-center justify-between">
        <p className="text-[10px] text-white/35 uppercase tracking-[3px]">
          {done ? "Analysis Complete" : "Running Inference"}
        </p>
        <span className="text-[11px] font-semibold text-white">
          {done ? "100%" : `${pct}%`}
        </span>
      </div>

      <div className="h-1.5 w-full rounded-full bg-white/10 overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-300 ${
            done ? "bg-green-400" : "bg-indigo-400"
          }`}
          style={{ width: done ? "100%" : `${pct}%` }}
        />
      </div>

      {!done && (
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-indigo-400 animate-pulse" />
            <span className="text-[10px] text-white/30 uppercase tracking-[2px]">
              CLIP encoding…
            </span>
          </div>
          <p className="text-[11px] text-white/40">
            {current} / {total}
          </p>
        </div>
      )}
    </GlassCard>
  );
}

// ─── PostScoreRow ─────────────────────────────────────────────────────────────

interface PostScoreRowProps {
  date: string;
  caption: string;
  scores: CategoryScores;
  imageUrl?: string;
  className?: string;
}

/** Compact row showing a post's caption and its single highest-scored need. */
export function PostScoreRow({
  date,
  caption,
  scores,
  imageUrl,
  className = "",
}: PostScoreRowProps) {
  const topCategory = [...CATEGORIES].sort((a, b) => scores[b] - scores[a])[0];
  const topScore = scores[topCategory];

  return (
    <div
      className={`flex items-start gap-3 py-2 border-b border-white/5 last:border-0 ${className}`}
    >
      {imageUrl && (
        <img
          src={imageUrl}
          alt=""
          className="h-10 w-10 rounded-lg object-cover flex-shrink-0 opacity-80"
        />
      )}

      <div className="flex-1 min-w-0">
        <p className="text-[10px] text-white/30 mb-0.5">{date}</p>
        <p className="text-[12px] text-white/70 truncate">{caption}</p>
      </div>

      <div className="flex flex-col items-end gap-1 flex-shrink-0">
        <span
          className="text-[10px] uppercase tracking-[2px] font-medium"
          style={{ color: CATEGORY_HEX[topCategory] }}
        >
          {CATEGORY_LABELS[topCategory]}
        </span>
        <span className="text-[12px] font-semibold text-white">
          {Math.round(topScore * 100)}%
        </span>
      </div>
    </div>
  );
}
