import { useEffect } from 'react'
import { usePostStore } from '../store/postStore'

export function usePosts() {
  const { setLoading, setPosts, setClusters, setCategories } = usePostStore()

  useEffect(() => {
    setLoading(true)
    fetch('/api/posts')
      .then((res) => res.json())
      .then((data) => {
        setPosts(data.posts ?? [])
        setClusters(data.clusters ?? {})
        setCategories(data.categories ?? [])
      })
      .catch((err) => console.error('Failed to fetch posts:', err))
      .finally(() => setLoading(false))
  }, [setLoading, setPosts, setClusters, setCategories])
}
