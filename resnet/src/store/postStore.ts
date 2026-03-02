import { create } from 'zustand'
import type { Post } from '../types/post'

interface PostStore {
  posts: Post[]
  loading: boolean
  setPosts: (posts: Post[]) => void
  setLoading: (loading: boolean) => void
}

export const usePostStore = create<PostStore>((set) => ({
  posts: [],
  loading: false,
  setPosts: (posts) => set({ posts }),
  setLoading: (loading) => set({ loading }),
}))
