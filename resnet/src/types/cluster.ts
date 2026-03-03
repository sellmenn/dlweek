export interface Cluster {
    name: string,
    centroid: {
        lat: number,
        long: number
    },
    count: number,
    severity_score: number,
    severity_class: "low" | "medium" | "high"
}