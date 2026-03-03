export interface Cluster {
<<<<<<< Updated upstream
    name: string;
    centroid: [number, number];
    count: number;
    combined_severity: 'little_or_none' | 'mild' | 'severe';
=======
    name: string,
    centroid: {
        lat: number,
        long: number
    },
    count: number,
    severity_score: number,
    severity_class: "low" | "medium" | "high"
>>>>>>> Stashed changes
}
