import { create } from 'zustand'
import type { Post } from '../types/post'
import type { Cluster } from '../types/cluster'

interface PostStore {
  posts: Post[]
  clusters: Record<string, Cluster>
  categories: string[]
  loading: boolean
  setPosts: (posts: Post[]) => void
  setClusters: (clusters: Record<string, Cluster>) => void
  setCategories: (categories: string[]) => void
  setLoading: (loading: boolean) => void
}

export const usePostStore = create<PostStore>((set) => ({
  posts: [],
  clusters: {},
  categories: [],
  loading: false,
  setPosts: (posts) => set({ posts }),
  setClusters: (clusters) => set({ clusters }),
  setCategories: (categories) => set({ categories }),
  setLoading: (loading) => set({ loading }),
}))
