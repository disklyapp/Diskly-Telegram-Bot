require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const { PrismaClient } = require('@prisma/client');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { nanoid } = require('nanoid');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const requiredEnvVars = ['BOT_TOKEN', 'DATABASE_URL', 'B2_ENDPOINT', 'B2_REGION', 'B2_ACCESS_KEY_ID', 'B2_SECRET_ACCESS_KEY', 'B2_BUCKET_NAME'];
const missingVars = requiredEnvVars.filter(v => !process.env[v]);

if (missingVars.length > 0) {
  console.error(`❌ ERROR: Missing required environment variables: ${missingVars.join(', ')}`);
  console.error("Please add them to your .env file in the telegram-bot folder.");
  process.exit(1);
}

const prisma = new PrismaClient({
  datasources: {
    db: {
      url: process.env.DATABASE_URL,
    },
  },
});

const s3 = new S3Client({
  endpoint: process.env.B2_ENDPOINT,
  region: process.env.B2_REGION,
  credentials: {
    accessKeyId: process.env.B2_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.B2_SECRET_ACCESS_KEY || '',
  },
});

const bot = new Telegraf(process.env.BOT_TOKEN);

const userSessions = {}; 

// Step 1: Start
bot.start((ctx) => {
  ctx.reply("Send your Diskly Telegram API Key to authenticate.");
});

// Step 2: Handle Text Input (Auth & Links)
bot.on('text', async (ctx) => {
  const telegramId = ctx.from.id;
  const text = ctx.message.text.trim();
  const session = userSessions[telegramId];

  if (!session) {
    try {
      const admin = await prisma.admin.findUnique({ where: { telegramUploadId: text } });
      if (admin) {
        userSessions[telegramId] = { adminId: admin.id, state: 'IDLE' };
        
        const keyboard = Markup.inlineKeyboard([
          [Markup.button.callback('📤 Upload Video', 'opt_upload')],
          [Markup.button.callback('🔄 Convert Diskly Link', 'opt_diskly')],
          [Markup.button.callback('📥 Convert Terabox Link', 'opt_terabox')],
        ]);
        
        ctx.reply("✅ Authenticated! Choose an option:", keyboard);
      } else {
        ctx.reply("❌ Invalid API Key. Try again.");
      }
    } catch (err) {
      console.error(err);
      ctx.reply("❌ Error verifying key.");
    }
    return;
  }

  // Handle states
  if (session.state === 'AWAITING_DISKLY_LINK') {
    // Extract downloadKey from diskly.in/{download_key}
    const match = text.match(/diskly\.in\/([a-zA-Z0-9_-]+)/);
    const downloadKey = match ? match[1] : text;

    try {
      const originalVideo = await prisma.video.findFirst({ where: { downloadKey } });
      if (!originalVideo) {
        return ctx.reply("❌ Video not found for that link.");
      }

      const newDownloadKey = nanoid(10);
      
      await prisma.video.create({
        data: {
          title: originalVideo.title,
          description: originalVideo.description,
          streamUrl: originalVideo.streamUrl,
          downloadKey: newDownloadKey,
          thumbnailUrl: originalVideo.thumbnailUrl,
          adminId: session.adminId
        }
      });

      userSessions[telegramId].state = 'IDLE';
      ctx.reply(`✅ Video copied successfully!\n\n🔗 https://diskly.in/${newDownloadKey}`);
    } catch (error) {
      console.error(error);
      ctx.reply("❌ Error copying video.");
    }
    return;
  }

  if (session.state === 'AWAITING_TERABOX_LINK') {
    ctx.reply("🔍 Fetching TeraBox data...");
    
    try {
      const response = await axios.post('https://xapiverse.com/api/terabox', 
        { url: text },
        {
          headers: {
            'Content-Type': 'application/json',
            'xAPIverse-Key': process.env.TERABOX_API_KEY
          }
        }
      );

      const data = response.data;
      if (data.status !== 'success' || !data.list || data.list.length === 0) {
        return ctx.reply("❌ Failed to fetch video from Terabox link.");
      }

      const fileInfo = data.list[0];
      const downloadUrl = fileInfo.normal_dlink || fileInfo.stream_url || fileInfo.fast_stream_url?.['1080p'] || fileInfo.fast_stream_url?.['720p'] || fileInfo.fast_stream_url?.['480p'];
      
      if (!downloadUrl) {
        return ctx.reply("❌ Could not find a valid download link from Terabox.");
      }

      ctx.reply("⬇️ Downloading video from Terabox...");

      const tempFilePath = path.join(__dirname, `${Date.now()}_${fileInfo.name || 'terabox.mp4'}`);
      
      const downloadResponse = await axios({
        url: downloadUrl,
        method: 'GET',
        responseType: 'stream'
      });

      const writer = fs.createWriteStream(tempFilePath);
      downloadResponse.data.pipe(writer);

      await new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
      });

      ctx.reply("☁️ Uploading to Storage...");

      const downloadKey = nanoid(10);
      const fileExtension = fileInfo.name ? fileInfo.name.split('.').pop() : 'mp4';
      const objectKey = `${downloadKey}.${fileExtension}`;

      const fileStream = fs.createReadStream(tempFilePath);
      const uploadParams = {
        Bucket: process.env.B2_BUCKET_NAME || 'disklyserver',
        Key: objectKey,
        Body: fileStream,
        ContentType: 'video/mp4',
      };

      await s3.send(new PutObjectCommand(uploadParams));

      let streamUrl = '';
      const domain = process.env.CLOUDFLARE_DOMAIN || '';
      if (domain.includes('/file/')) {
        streamUrl = `${domain.replace(/\/$/, '')}/${objectKey}`;
      } else {
        streamUrl = `https://${domain.replace(/\/$/, '')}/file/${process.env.B2_BUCKET_NAME}/${objectKey}`;
      }

      await prisma.video.create({
        data: {
          title: fileInfo.name || "Terabox Video",
          description: "",
          streamUrl,
          downloadKey,
          thumbnailUrl: "",
          adminId: session.adminId
        }
      });

      userSessions[telegramId].state = 'IDLE';
      ctx.reply(`✅ Video uploaded successfully!\n\n🔗 https://diskly.in/${downloadKey}`);

      if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);

    } catch (error) {
      console.error(error);
      ctx.reply("❌ Error processing Terabox link.");
    }
    return;
  }

  // If IDLE or something else, prompt to use menu
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('📤 Upload Video', 'opt_upload')],
    [Markup.button.callback('🔄 Convert Diskly Link', 'opt_diskly')],
    [Markup.button.callback('📥 Convert Terabox Link', 'opt_terabox')],
  ]);
  ctx.reply("Please select an option:", keyboard);
});

// Action Handlers
bot.action('opt_upload', (ctx) => {
  const telegramId = ctx.from.id;
  if (!userSessions[telegramId]) return ctx.reply("❌ Please authenticate first.");
  userSessions[telegramId].state = 'AWAITING_UPLOAD_VIDEO';
  ctx.reply("📤 Please send the video you want to upload.");
  ctx.answerCbQuery();
});

bot.action('opt_diskly', (ctx) => {
  const telegramId = ctx.from.id;
  if (!userSessions[telegramId]) return ctx.reply("❌ Please authenticate first.");
  userSessions[telegramId].state = 'AWAITING_DISKLY_LINK';
  ctx.reply("🔄 Send the Diskly link (e.g. diskly.in/xyz123) to copy.");
  ctx.answerCbQuery();
});

bot.action('opt_terabox', (ctx) => {
  const telegramId = ctx.from.id;
  if (!userSessions[telegramId]) return ctx.reply("❌ Please authenticate first.");
  userSessions[telegramId].state = 'AWAITING_TERABOX_LINK';
  ctx.reply("📥 Send the Terabox link to download and upload.");
  ctx.answerCbQuery();
});

// Video Handler
bot.on('video', async (ctx) => {
  const telegramId = ctx.from.id;
  const session = userSessions[telegramId];

  if (!session) {
    return ctx.reply("❌ Please authenticate first by sending your Diskly Telegram API Key.");
  }

  if (session.state !== 'AWAITING_UPLOAD_VIDEO') {
    return ctx.reply("❌ Please select 'Upload Video' from the menu first.");
  }

  const adminId = session.adminId;
  const video = ctx.message.video;

  try {
    const admin = await prisma.admin.findUnique({ where: { id: adminId } });
    if (!admin) return ctx.reply("❌ Admin not found.");

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const videosToday = await prisma.video.count({
      where: { adminId, createdAt: { gte: today } }
    });

    if (videosToday >= admin.dailyUploadLimit) {
      return ctx.reply("❌ Daily upload limit reached.");
    }

    ctx.reply("⬇️ Downloading video...");

    const fileLink = await ctx.telegram.getFileLink(video.file_id);
    const tempFilePath = path.join(__dirname, `${Date.now()}_${video.file_name || 'video.mp4'}`);

    const response = await axios({
      url: fileLink.href,
      method: 'GET',
      responseType: 'stream'
    });

    const writer = fs.createWriteStream(tempFilePath);
    response.data.pipe(writer);

    await new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });

    ctx.reply("☁️ Uploading to Storage...");

    const caption = ctx.message.caption || "";
    let title = video.file_name || "video.mp4";
    let description = "";

    if (caption) {
      const parts = caption.split("|").map(p => p.trim());
      if (parts.length > 1) {
        title = parts[0];
        description = parts.slice(1).join(" | ");
      } else {
        title = parts[0];
      }
    }

    const downloadKey = nanoid(10);
    const fileExtension = video.file_name ? video.file_name.split('.').pop() : 'mp4';
    const objectKey = `${downloadKey}.${fileExtension}`;

    const fileStream = fs.createReadStream(tempFilePath);
    const uploadParams = {
      Bucket: process.env.B2_BUCKET_NAME || 'disklyserver',
      Key: objectKey,
      Body: fileStream,
      ContentType: video.mime_type || 'video/mp4',
    };

    await s3.send(new PutObjectCommand(uploadParams));

    let streamUrl = '';
    const domain = process.env.CLOUDFLARE_DOMAIN || '';
    if (domain.includes('/file/')) {
      streamUrl = `${domain.replace(/\/$/, '')}/${objectKey}`;
    } else {
      streamUrl = `https://${domain.replace(/\/$/, '')}/file/${process.env.B2_BUCKET_NAME}/${objectKey}`;
    }

    await prisma.video.create({
      data: {
        title,
        description,
        streamUrl,
        downloadKey,
        thumbnailUrl: "",
        adminId
      }
    });

    userSessions[telegramId].state = 'IDLE';
    ctx.reply(`✅ Video uploaded successfully!\n\n🔗 https://diskly.in/${downloadKey}`);

    if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);

  } catch (err) {
    console.error(err);
    ctx.reply("❌ Error uploading video.");
  }
});

bot.launch();
console.log("🤖 Bot is running...");
