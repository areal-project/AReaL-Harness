import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';
export default defineConfig({ base:'./', plugins:[react(),tailwindcss()], resolve:{alias:{'@':fileURLToPath(new URL('./src',import.meta.url))}}, build:{outDir:'dist',emptyOutDir:true, commonjsOptions:{include:[/node_modules/,/desktop-contract\.cjs$/]}} });
