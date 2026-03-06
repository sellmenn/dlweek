export interface Cluster {
    name: string;
    centroid: [number, number];
    count: number;
    population?: number;
    combined_severity?: 'little_or_none' | 'mild' | 'severe';
}