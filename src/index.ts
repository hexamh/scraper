import { Bot, webhookCallback } from 'grammy';

// Cloudflare Worker Environment Bindings
export interface Env {
	DB: D1Database;
	TELEGRAM_BOT_TOKEN: string;
	WEBHOOK_SECRET: string;
	CF_ACCOUNT_ID: string;
	CF_API_TOKEN: string;
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const bot = new Bot(env.TELEGRAM_BOT_TOKEN);

		// URL Validation Function (Security Check)
		const isValidUrl = (url: string) => {
			try {
				new URL(url);
				return true;
			} catch (e) {
				return false;
			}
		};

		bot.command('start', (ctx) => {
			ctx.reply('AI Data Scraper Bot-এ স্বাগতম! \nব্যবহারবিধি:\n/crawl <URL> - ক্রল শুরু করতে\n/status <JOB_ID> - ডেটা সংগ্রহ করতে');
		});

		// Command: Initiate Crawl
		bot.command('crawl', async (ctx) => {
			const url = ctx.match;
			if (!url || !isValidUrl(url)) {
				return ctx.reply('⚠️ অনুগ্রহ করে একটি সঠিক URL প্রদান করুন। উদাহরণ: /crawl https://example.com/docs');
			}

			try {
				// Cloudflare Browser Rendering API Call for AI purposes
				const cfResponse = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/browser-rendering/crawl`, {
					method: 'POST',
					headers: {
						'Authorization': `Bearer ${env.CF_API_TOKEN}`,
						'Content-Type': 'application/json'
					},
					body: JSON.stringify({
						url: url,
						limit: 50,
						depth: 2,
						formats: ["markdown"], // AI/RAG এর জন্য অপ্টিমাইজড
						crawlPurposes: ["ai-input", "ai-train", "search"],
						options: {
							includeExternalLinks: false
						}
					})
				});

				const result: any = await cfResponse.json();

				if (!result.success) {
					return ctx.reply(`❌ ক্রল শুরু করতে ব্যর্থ হয়েছে: ${JSON.stringify(result.errors)}`);
				}

				const jobId = result.result;

				// Store Job in D1 (Parameterized query to prevent SQLi)
				await env.DB.prepare(
					'INSERT INTO crawl_jobs (job_id, url, chat_id, status) VALUES (?, ?, ?, ?)'
				).bind(jobId, url, ctx.chat.id, 'queued').run();

				ctx.reply(`✅ ক্রল শুরু হয়েছে!\nJob ID: \`${jobId}\`\n\nকিছুক্ষণ পর স্ট্যাটাস দেখতে টাইপ করুন:\n/status ${jobId}`, { parse_mode: 'Markdown' });

			} catch (error) {
				ctx.reply('⚠️ ইন্টারনাল সার্ভার এরর দেখা দিয়েছে।');
			}
		});

		// Command: Check Status & Retrieve Data
		bot.command('status', async (ctx) => {
			const jobId = ctx.match?.trim();
			if (!jobId) {
				return ctx.reply('⚠️ অনুগ্রহ করে Job ID দিন। উদাহরণ: /status <job_id>');
			}

			try {
				const cfResponse = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/browser-rendering/crawl/${jobId}`, {
					method: 'GET',
					headers: {
						'Authorization': `Bearer ${env.CF_API_TOKEN}`
					}
				});

				const result: any = await cfResponse.json();

				if (!result.success) {
					return ctx.reply('❌ Job ID খুঁজে পাওয়া যায়নি বা API এরর।');
				}

				const jobStatus = result.result.status;

				// Update Database state
				await env.DB.prepare(
					'UPDATE crawl_jobs SET status = ? WHERE job_id = ?'
				).bind(jobStatus, jobId).run();

				if (jobStatus !== 'completed') {
					return ctx.reply(`⏳ বর্তমান স্ট্যাটাস: *${jobStatus.toUpperCase()}*\nঅনুগ্রহ করে আরও কিছুক্ষণ অপেক্ষা করুন।`, { parse_mode: 'Markdown' });
				}

				// If completed, aggregate markdown records
				const records = result.result.records || [];
				let aggregatedMarkdown = '';
				
				records.forEach((record: any) => {
					if (record.status === 'completed' && record.markdown) {
						aggregatedMarkdown += `\n\n\n\n${record.markdown}`;
					}
				});

				if (!aggregatedMarkdown) {
					return ctx.reply('⚠️ ক্রল সম্পন্ন হয়েছে কিন্তু কোনো কন্টেন্ট এক্সট্রাক্ট করা যায়নি।');
				}

				// Since Telegram message length limit is 4096, send as a Document file
				const fileBuffer = new TextEncoder().encode(aggregatedMarkdown);
				
				await ctx.replyWithDocument(
					new InputFile(fileBuffer, `scraped_data_${jobId.substring(0, 5)}.md`),
					{ caption: `✅ সফলভাবে ${records.length} টি পেজ স্ক্র্যাপ করা হয়েছে।` }
				);

			} catch (error) {
				ctx.reply('⚠️ স্ট্যাটাস চেক করার সময় এরর হয়েছে।');
			}
		});

		// Webhook Handler
		const handleWebhook = webhookCallback(bot, 'cloudflare-mod');
		
		// Basic security: validate webhook secret if configured
		const secret = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
		if (env.WEBHOOK_SECRET && secret !== env.WEBHOOK_SECRET) {
			return new Response('Unauthorized', { status: 403 });
		}

		if (request.method === 'POST') {
			return handleWebhook(request);
		}

		return new Response('Bot is running safely at edge.', { status: 200 });
	},
};
