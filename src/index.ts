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
// ==========================================
// RUTE WEBHOOK TELEGRAM BOT
// ==========================================
app.post('/bot-webhook', async (c) => {
    // [Belum Terverifikasi] Kode ini berasumsi Anda telah mengizinkan variabel ini di types.ts
    const token = (c.env as any).TELEGRAM_BOT_TOKEN;
    const secret = (c.env as any).TELEGRAM_SECRET_TOKEN;

    // Mitigasi permintaan palsu
    if (secret && c.req.header('X-Telegram-Bot-Api-Secret-Token') !== secret) {
        return c.json(createErrorResponse('Unauthorized request'), 401);
    }

    let body;
    try {
        body = await c.req.json();
    } catch {
        return c.json(createErrorResponse('Invalid JSON format'), 400);
    }

    if (!body?.message?.text || !body?.message?.chat?.id) {
        return c.text('OK', 200);
    }

    const text = body.message.text.trim();
    const chatId = body.message.chat.id;
    let replyMessage = 'Ketik /harga untuk mengecek harga Antam dari Aneka Logam.';

    if (text === '/harga') {
        try {
            // Memanggil API internal
            const url = new URL(c.req.url);
            const res = await fetch(`${url.origin}/api/prices/anekalogam`);
            if (res.ok) {
                const data: any = await res.json();
                const item = data.data?.[0];
                if (item) {
                    replyMessage = `📊 *Harga Emas*\nJual: Rp ${item.sellPrice}\nBuyback: Rp ${item.buybackPrice}`;
                }
            }
        } catch {
            replyMessage = 'Sedang terjadi gangguan jaringan ke sumber data.';
        }
    }

    try {
        await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text: replyMessage, parse_mode: 'Markdown' })
        });
    } catch (e) {
        // [Inferensi] Log error secara diam-diam agar tidak menghentikan runtime
    }

    return c.text('OK', 200);
});
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

export default app;
