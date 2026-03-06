export interface Post {
  lat: number;
  lon: number;
  caption: string;
  cluster: number;
  image: string;
  date: string;
  timestamp: number;
}

export interface AnalyzedPost extends Post {
  scores: Record<string, number>;
  severity_label: string;
  informative: boolean;
}