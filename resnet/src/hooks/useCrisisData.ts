import { useEffect } from "react";
import { useCrisisStore } from "../store/crisisStore";

export function useCrisisData() {
  const { setCrises, setLoading } = useCrisisStore();

  useEffect(() => {
    const fetchData = async () => {
      setLoading(true);
      try {
        // TODO: replace with real API call
        // const res = await fetch('/api/crises')
        // const data: Crisis[] = await res.json()
        // setCrises(data)
        setCrises([]);
      } catch (err) {
        console.error("Failed to fetch crisis data:", err);
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, [setCrises, setLoading]);
}
