import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Project sites are served at /<repo>/. User and organization sites use /.
function pagesBase(): string {
  if (!process.env.GITHUB_ACTIONS) return '/'

  const repo = process.env.GITHUB_REPOSITORY?.split('/')[1]
  if (!repo || repo.endsWith('.github.io')) return '/'

  return `/${repo}/`
}

// https://vite.dev/config/
export default defineConfig({
  base: pagesBase(),
  plugins: [react()],
})
