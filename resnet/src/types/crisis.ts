// TODO: update these fields to match your actual API response

export type Severity = "low" | "medium" | "high" | "critical";

export interface Crisis {
  severity: Severity;
  location: { lat: number; lng: number };
  number_affected: number;
  aid_rank: string[];
  napi_score: number;
}
