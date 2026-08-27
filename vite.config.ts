/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const host = process.env.TAURI_DEV_HOST;

// Раздача сборочных артефактов (Windows-экзешник, архивы исходников) в dev-режиме.
// Папка /home/z/artifacts живёт вне репозитория, чтобы не попадать ни в git, ни в dist.
function downloadArtifacts(): Plugin {
  const ARTIFACTS = '/home/z/artifacts';
  const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} МБ`;
  return {
    name: 'osucup-artifacts',
    configureServer(server) {
      server.middlewares.use('/downloads', (req, res, next) => {
        const rel = decodeURIComponent((req.url ?? '').replace(/^\/+/, '')).split('?')[0] ?? '';
        if (!rel) {
          // Список артефактов простым HTML — чтобы качать прямо из превью-панели.
          let files: fs.Dirent[] = [];
          try {
            files = fs.readdirSync(ARTIFACTS, { withFileTypes: true }).filter((f) => f.isFile());
          } catch {
            /* пусто */
          }
          const rows = files
            .map((f) => {
              const size = fs.statSync(path.join(ARTIFACTS, f.name)).size;
              const note = f.name.includes('setup')
                ? 'установщик — запусти и дальше «Далее»'
                : f.name.includes('portable')
                  ? 'портативная — распакуй в любую папку и запускай'
                  : f.name.includes('source')
                    ? 'исходники — для запуска нужен Node.js + pnpm + Rust'
                    : '';
              return `<tr><td><a href="/downloads/${encodeURIComponent(f.name)}">${f.name}</a></td><td>${mb(size)}</td><td>${note}</td></tr>`;
            })
            .join('\n');
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.end(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>osu!cup — сборки</title>
<style>body{background:#0c0e13;color:#e8e8ee;font:14px/1.6 system-ui,sans-serif;max-width:760px;margin:48px auto;padding:0 20px}
a{color:#ff6fb1;text-decoration:none}a:hover{text-decoration:underline}h1{font-size:22px}
table{border-collapse:collapse;width:100%;margin-top:16px}td,th{padding:8px 12px;border-bottom:1px solid #23262f;text-align:left}
td:nth-child(2){color:#9aa0ad;white-space:nowrap}td:nth-child(3){color:#9aa0ad}
.note{color:#9aa0ad;margin-top:20px;font-size:13px}</style></head><body>
<h1>osu!cup — сборки для Windows</h1>
<p>Скачать и тестировать. SmartScreen может предупредить о неизвестном издателе — это нормально, сборка без подписи: «Подробнее» → «Выполнить в любом случае».</p>
<table><tr><th>Файл</th><th>Размер</th><th>Что это</th></tr>
${rows}
</table>
<p class="note">Приложение для своих: данные лежат локально (SQLite), интернет нужен только для загрузки карт с osu!.</p>
</body></html>`);
          return;
        }
        if (!/^[A-Za-z0-9._!-]+$/.test(rel)) {
          next();
          return;
        }
        const file = path.join(ARTIFACTS, rel);
        let stat: fs.Stats;
        try {
          stat = fs.statSync(file);
        } catch {
          res.statusCode = 404;
          res.end('not found');
          return;
        }
        if (!stat.isFile()) {
          res.statusCode = 404;
          res.end('not found');
          return;
        }
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Disposition', `attachment; filename="${rel}"`);
        res.setHeader('Content-Length', String(stat.size));
        if (req.method === 'HEAD') {
          res.end();
          return;
        }
        fs.createReadStream(file).pipe(res);
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), downloadArtifacts()],

  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },

  // Tauri ждёт фиксированный порт и падает, если его занять.
  clearScreen: false,
  server: {
    port: 5180,
    strictPort: true,
    host: host || false,
    // Превью-панель проксирует приложение через Next.js на :3000 — внешний
    // Host не должен ломать dev-сервер (иначе vite отвечает 403).
    allowedHosts: true,
    ...(host ? { hmr: { protocol: 'ws', host, port: 5181 } } : {}),
    watch: { ignored: ['**/src-tauri/**'] },
  },

  envPrefix: ['VITE_', 'TAURI_ENV_*'],
  build: {
    target: process.env.TAURI_ENV_PLATFORM === 'windows' ? 'chrome105' : 'safari13',
    minify: process.env.TAURI_ENV_DEBUG ? false : 'esbuild',
    sourcemap: !!process.env.TAURI_ENV_DEBUG,

    // Две точки входа: приложение и страница зрителя. Страница собирается
    // отдельно, потому что не должна тянуть код IPC, библиотеки и редакторов —
    // её отдаёт свой сервер зрителям, а не вебвью Tauri.
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        air: fileURLToPath(new URL('./air.html', import.meta.url)),
      },
    },
  },

  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
