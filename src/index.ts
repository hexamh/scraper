// src/index.ts
import { Bot, webhookCallback, InputFile } from 'grammy';

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

		bot.command('start', async (ctx) => {
			await ctx.reply('AI Data Scraper Bot-এ স্বাগতম! \nব্যবহারবিধি:\n/crawl <URL> - ক্রল শুরু করতে\n/status <JOB_ID> - ডেটা সংগ্রহ করতে');
		});

		bot.command('crawl', async (ctx) => {
			const url = ctx.match;
			const chatId = ctx.chat?.id;

			if (!url || !isValidUrl(url)) {
				return await ctx.reply('⚠️ অনুগ্রহ করে একটি সঠিক URL প্রদান করুন। উদাহরণ: /crawl https://example.com/docs');
			}
			if (!chatId) return;

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
						formats: ["markdown"],
						crawlPurposes: ["ai-input", "ai-train", "search"],
						options: {
							includeExternalLinks: false
						}
					})
				});

				const result: any = await cfResponse.json();

				if (!result.success) {
					return await ctx.reply(`❌ ক্রল শুরু করতে ব্যর্থ হয়েছে: ${JSON.stringify(result.errors)}`);
				}

				const jobId = result.result;

				// Store Job in D1 (Parameterized query to prevent SQLi)
				await env.DB.prepare(
					'INSERT INTO crawl_jobs (job_id, url, chat_id, status) VALUES (?, ?, ?, ?)'
				).bind(jobId, url, chatId, 'queued').run();

				// Use HTML instead of MarkdownV2 to prevent API crashes on unescaped UUID hyphens
				await ctx.reply(`✅ ক্রল শুরু হয়েছে!\nJob ID: <code>${jobId}</code>\n\nকিছুক্ষণ পর স্ট্যাটাস দেখতে টাইপ করুন:\n/status ${jobId}\n(অথবা বট স্বয়ংক্রিয়ভাবে কাজ শেষে আপনাকে জানাবে)`, { parse_mode: 'HTML' });

			} catch (error) {
				await ctx.reply('⚠️ ইন্টারনাল সার্ভার এরর দেখা দিয়েছে।');
			}
		});

		bot.command('status', async (ctx) => {
			const jobId = ctx.match?.trim();
			if (!jobId) {
				return await ctx.reply('⚠️ অনুগ্রহ করে Job ID দিন। উদাহরণ: /status <job_id>');
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
					return await ctx.reply('❌ Job ID খুঁজে পাওয়া যায়নি বা API এরর।');
				}

				const jobStatus = result.result.status;

				// Update Database state
				await env.DB.prepare(
					'UPDATE crawl_jobs SET status = ? WHERE job_id = ?'
				).bind(jobStatus, jobId).run();

				if (jobStatus !== 'completed') {
					return await ctx.reply(`⏳ বর্তমান স্ট্যাটাস: <b>${jobStatus.toUpperCase()}</b>\nঅনুগ্রহ করে আরও কিছুক্ষণ অপেক্ষা করুন।`, { parse_mode: 'HTML' });
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
					return await ctx.reply('⚠️ ক্রল সম্পন্ন হয়েছে কিন্তু কোনো কন্টেন্ট এক্সট্রাক্ট করা যায়নি।');
				}

				const fileBuffer = new TextEncoder().encode(aggregatedMarkdown);
				
				await ctx.replyWithDocument(
					new InputFile(fileBuffer, `scraped_data_${jobId.substring(0, 5)}.md`),
					{ caption: `✅ সফলভাবে ${records.length} টি পেজ স্ক্র্যাপ করা হয়েছে।` }
				);

			} catch (error) {
				await ctx.reply('⚠️ স্ট্যাটাস চেক করার সময় এরর হয়েছে।');
			}
		});

		const handleWebhook = webhookCallback(bot, 'cloudflare-mod');
		
		const secret = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
		if (env.WEBHOOK_SECRET && secret !== env.WEBHOOK_SECRET) {
			return new Response('Unauthorized', { status: 403 });
		}

		if (request.method === 'POST') {
			return handleWebhook(request);
		}

		return new Response('Bot is running safely at edge.', { status: 200 });
	},

	// Background Cron Trigger: Auto-checks pending jobs and notifies users without requiring manual polling
	async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
		const bot = new Bot(env.TELEGRAM_BOT_TOKEN);
		
		try {
			const { results: pendingJobs } = await env.DB.prepare(
				"SELECT * FROM crawl_jobs WHERE status IN ('queued', 'running')"
			).all();

			if (!pendingJobs || pendingJobs.length === 0) return;

			for (const job of pendingJobs) {
				const cfResponse = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/browser-rendering/crawl/${job.job_id}`, {
					method: 'GET',
					headers: { 'Authorization': `Bearer ${env.CF_API_TOKEN}` }
				});

				const result: any = await cfResponse.json();
				if (!result.success) continue;

				const jobStatus = result.result.status;
				if (jobStatus === job.status) continue; 

				// State changed, update DB
				await env.DB.prepare('UPDATE crawl_jobs SET status = ? WHERE job_id = ?').bind(jobStatus, job.job_id).run();

				if (jobStatus === 'completed') {
					const records = result.result.records || [];
					let aggregatedMarkdown = '';
					
					records.forEach((record: any) => {
						if (record.status === 'completed' && record.markdown) {
							aggregatedMarkdown += `\n\n\n\n${record.markdown}`;
						}
					});

					if (aggregatedMarkdown) {
						const fileBuffer = new TextEncoder().encode(aggregatedMarkdown);
						await bot.api.sendDocument(
							job.chat_id as number, 
							new InputFile(fileBuffer, `scraped_data_${(job.job_id as string).substring(0, 5)}.md`),
							{ caption: `✅ আপনার ক্রলটি সফলভাবে সম্পন্ন হয়েছে! (${records.length} পেজ)` }
						);
					} else {
						await bot.api.sendMessage(job.chat_id as number, `⚠️ আপনার ক্রলটি (<code>${job.job_id}</code>) সম্পন্ন হয়েছে কিন্তু কোনো কন্টেন্ট এক্সট্রাক্ট করা যায়নি।`, { parse_mode: 'HTML' });
					}
				} else if (['errored', 'cancelled_due_to_limits', 'cancelled_due_to_timeout'].includes(jobStatus)) {
					await bot.api.sendMessage(job.chat_id as number, `❌ আপনার ক্রলটি (<code>${job.job_id}</code>) ব্যর্থ হয়েছে। কারণ: ${jobStatus}`, { parse_mode: 'HTML' });
				}
			}
		} catch (error) {
			console.error("Scheduled task error:", error);
		}
	}
};
