import { createReadStream } from 'fs';
import { access } from 'fs/promises';
import { join } from 'path';
import { FastifyInstance } from 'fastify';

type FrontendAsset = {
  fileName: string;
  contentType: string;
};

const PUBLIC_DIR = join(process.cwd(), 'public');

const FRONTEND_ASSETS: Record<string, FrontendAsset> = {
  '/': { fileName: 'index.html', contentType: 'text/html; charset=utf-8' },
  '/index.html': { fileName: 'index.html', contentType: 'text/html; charset=utf-8' },
  '/styles.css': { fileName: 'styles.css', contentType: 'text/css; charset=utf-8' },
  '/mock-data.js': { fileName: 'mock-data.js', contentType: 'application/javascript; charset=utf-8' },
  '/utils.js': { fileName: 'utils.js', contentType: 'application/javascript; charset=utf-8' },
  '/app-chrome.jsx': { fileName: 'app-chrome.jsx', contentType: 'text/babel; charset=utf-8' },
  '/app-flow.jsx': { fileName: 'app-flow.jsx', contentType: 'text/babel; charset=utf-8' },
  '/app.jsx': { fileName: 'app.jsx', contentType: 'text/babel; charset=utf-8' },
};

export async function registerFrontendRoutes(fastify: FastifyInstance) {
  for (const [route, asset] of Object.entries(FRONTEND_ASSETS)) {
    fastify.get(route, async (_request, reply) => {
      const assetPath = join(PUBLIC_DIR, asset.fileName);

      try {
        await access(assetPath);
      } catch {
        return reply.code(404).send({
          error: {
            code: 'FRONTEND_ASSET_NOT_FOUND',
            message: `${asset.fileName} not found in public directory`,
          },
        });
      }

      return reply
        .type(asset.contentType)
        .header('Cache-Control', 'no-cache')
        .send(createReadStream(assetPath));
    });
  }
}
