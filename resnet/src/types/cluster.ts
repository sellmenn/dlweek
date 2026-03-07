export interface Cluster {
    name: string;
    state?: string;
    centroid: [number, number];
    count: number;
    population?: number;
    combined_severity?: 'little_or_none' | 'mild' | 'severe';
}