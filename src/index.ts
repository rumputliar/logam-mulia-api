import { OpenAPIHono } from '@hono/zod-openapi';
import { Scalar } from '@scalar/hono-api-reference';
import { cors } from 'hono/cors';
import { createErrorResponse, getHistoryBySource } from './lib';
import { registerPriceFeatures } from './lib/feature-registry';
import { registerNewsFeatures } from './lib/news-registry';
import type { Bindings } from './types';
import rootRoute from './features/root';
import healthRoute from './features/health';
import { listSourcesRoute, historyRoute } from './lib/openapi-helpers';

const app = new OpenAPIHono<{ Bindings: Bindings }>();
app.use(
    '*',
    cors({
        origin: '*',
        allowMethods: ['GET', 'OPTIONS'],
        allowHeaders: ['Content-Type'],
        maxAge: 86400,
    }),
);

app.route('/', rootRoute);
app.route('/health', healthRoute);

const SOURCES = registerPriceFeatures(app);

registerNewsFeatures(app);

app.openapi(listSourcesRoute, (c) => {
    return c.json({ data: SOURCES });
});

const SUPPORTED_SOURCES = new Set(SOURCES.map((s) => s.name));
const sourceByName = new Map(SOURCES.map((s) => [s.name, s]));

app.get('/api/prices/:source/history', async (c) => {
    const source = c.req.param('source');
    if (!SUPPORTED_SOURCES.has(source)) {
        return c.json(createErrorResponse('Unknown source'), 404);
    }

    const result = await getHistoryBySource(c.env, source, {
        page: c.req.query('page'),
        length: c.req.query('length'),
        weight: c.req.query('weight'),
        material: c.req.query('material'),
        materialType: c.req.query('materialType'),
    });

    if (!result.success) {
        const statusCode = result.statusCode === 400 ? 400 : 500;
        return c.json(createErrorResponse(result.error ?? 'Unknown error'), statusCode);
    }

    const info = sourceByName.get(source);
    const meta = {
        url: info?.url ?? `/api/prices/${source}`,
        displayName: info?.displayName,
        logo: info?.logo,
        favicon: info?.favicon ?? null,
        cover: info?.cover ?? null,
        urlHomepage: info?.urlHomepage,
    };

    return c.json({
        ...result,
        data: result.data?.map((item) => ({ ...item, ...meta })),
    });
});

app.openAPIRegistry.registerPath(historyRoute);

app.doc('/api/docs/json', {
    openapi: '3.0.3',
    info: {
        title: 'Logam Mulia API',
        description:
            'API harga emas dan logam mulia dari berbagai sumber di Indonesia. Data discrape secara real-time dan di-cache per hari.',
        version: '1.0.0',
    },
    servers: [{ url: 'http://localhost:8787', description: 'Development' }],
    tags: [
        { name: 'System', description: 'Root & health check' },
        { name: 'Sources', description: 'Daftar & harga dari sumber logam mulia' },
        { name: 'History', description: 'Riwayat harga' },
        { name: 'News', description: 'Berita logam mulia' },
    ],
});

app.get('/api/docs', Scalar({ url: '/api/docs/json' }));

// ==========================================
// EXPORT CLOUDFLARE WORKERS (API & CRON JOB)
// ==========================================
export default {
    fetch: app.fetch,

    scheduled: async (event: any, env: any, ctx: any) => {
        ctx.waitUntil((async () => {
            console.log("1. Cron job (Gabungan & Rata-rata) dimulai...");
            
            const token = env.TELEGRAM_BOT_TOKEN;
            const channelId = env.TELEGRAM_CHANNEL_ID;

            if (!token || !channelId) return;

            const sources = [
                'anekalogam', 'indogold', 'hargaemas-org', 'galeri24', 
                'bankbsi', 'pegadaian', 'kursdolar', 'hargaemas-net'
            ];

            let totalSellPrice = 0;
            let totalBuybackPrice = 0;
            let validSourceCount = 0;
            let detailPesan = ""; 

            for (let i = 0; i < sources.length; i++) {
                const source = sources[i];
                console.log(`Mengambil data: ${source}...`);

                try {
                    const reqUrl = `https://logam-mulia-api.en68.workers.dev/api/prices/${source}`;
                    const req = new Request(reqUrl);
                    const response = await app.fetch(req, env, ctx);
                    
                    if (response.ok) {
                        const json: any = await response.json();
                        const item = json.data?.[0];

                        if (item && item.sellPrice) {
                            totalSellPrice += Number(item.sellPrice);
                            totalBuybackPrice += Number(item.buybackPrice || 0);
                            validSourceCount++;

                            detailPesan += `🔹 *${source.toUpperCase()}*: Jual Rp ${Number(item.sellPrice).toLocaleString('id-ID')} | Beli Rp ${Number(item.buybackPrice || 0).toLocaleString('id-ID')}\n`;
                        }
                    }
                } catch (e: any) {
                    console.log(`ERROR pada ${source}:`, e.message);
                }
            }

            if (validSourceCount > 0) {
                console.log("Merakit pesan gabungan...");
                const avgSell = Math.round(totalSellPrice / validSourceCount);
                const avgBuyback = Math.round(totalBuybackPrice / validSourceCount);

                let finalMessage = `🌟 *UPDATE HARGA EMAS TERKINI* 🌟\n\n` +
                                   `${detailPesan}\n` +
                                   `📈 *RATA-RATA (${validSourceCount} Sumber)*\n` +
                                   `💰 Jual: Rp ${avgSell.toLocaleString('id-ID')}\n` +
                                   `🔄 Buyback: Rp ${avgBuyback.toLocaleString('id-ID')}`;

                // PENAMBAHAN PENGAMAN BATAS KARAKTER (Batas aman 4000 dari max 4096)
                if (finalMessage.length > 4000) {
                    finalMessage = finalMessage.substring(0, 4000) + "\n\n... [Teks terpotong karena batas limit Telegram]";
                }

                await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        chat_id: channelId,
                        text: finalMessage,
                        parse_mode: 'Markdown'
                    })
                });
                console.log("Pesan gabungan sukses dikirim ke Telegram.");
            }
        })());
    }
};
