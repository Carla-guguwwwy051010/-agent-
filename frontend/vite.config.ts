import { defineConfig } from 'vite'
import { viteSingleFile } from 'vite-plugin-singlefile'

export default defineConfig({
  base: './',
  plugins: [viteSingleFile()],
  server: { proxy: { '/api': 'http://127.0.0.1:8000' } },
})
