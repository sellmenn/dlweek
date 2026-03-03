import { usePredictStore } from '../store/predictStore'

/**
 * Opens an SSE connection to /api/predict.
 * Call the returned `run` function to start inference.
 * Progress and results are written to predictStore.
 */
export function usePredict() {
  const { setRunning, setProgress, setResults, reset } = usePredictStore()

  function run() {
    reset()
    setRunning(true)

    const source = new EventSource('/api/predict')

    source.onmessage = (event) => {
      const data = JSON.parse(event.data)

      if (data.type === 'progress') {
        setProgress(data.current, data.total)
      } else if (data.type === 'done') {
        setResults(data.post_scores, data.cluster_scores)
        source.close()
      }
    }

    source.onerror = (err) => {
      console.error('SSE error:', err)
      setRunning(false)
      source.close()
    }
  }

  return { run }
}
