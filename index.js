require('dotenv').config();
const { Telegraf } = require('telegraf');
const { PrismaClient } = require('@prisma/client');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { nanoid } = require('nanoid');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const prisma = new PrismaClient();

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

// Step 2: Save UID
bot.on('text', async (ctx) => {
  const telegramId = ctx.from.id;
  const key = ctx.message.text.trim();

  try {
    const admin = await prisma.admin.findUnique({ where: { telegramUploadId: key } });
    if (admin) {
      userSessions[telegramId] = admin.id;
      ctx.reply("✅ Authenticated! Now send a video.");
    } else {
      ctx.reply("❌ Invalid API Key. Try again.");
    }
  } catch (err) {
    console.error(err);
    ctx.reply("❌ Error verifying key.");
  }
});

// Video Handler
bot.on('video', async (ctx) => {
  const telegramId = ctx.from.id;

  if (!userSessions[telegramId]) {
    return ctx.reply("❌ Please authenticate first by sending your Diskly Telegram API Key.");
  }

  const adminId = userSessions[telegramId];
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

    ctx.reply(`✅ Video uploaded successfully!\n\n🔗 https://diskly.in/${downloadKey}`);

    if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);

  } catch (err) {
    console.error(err);
    ctx.reply("❌ Error uploading video.");
  }
});

bot.launch();
console.log("🤖 Bot is running...");
