import express from "express";
import axios from "axios";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json({ limit: "2mb" }));

const TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_ID = process.env.WHATSAPP_PHONE_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const ADMIN_KEY = process.env.ADMIN_KEY || "admin";
const PORT = process.env.PORT || 3000;

const mediaDir = path.join(process.cwd(), "media");
if (!fs.existsSync(mediaDir)) fs.mkdirSync(mediaDir);

const contactsFile = path.join(process.cwd(), "contacts.json");
function readContacts() {
  try {
    return JSON.parse(fs.readFileSync(contactsFile, "utf8"));
  } catch {
    return { contacts: {} };
  }
}
function writeContacts(data) {
  fs.writeFileSync(contactsFile, JSON.stringify(data, null, 2));
}

// Health check
app.get("/health", (_req, res) => res.json({ ok: true }));

// Webhook verification
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// Webhook messages
app.post("/webhook", async (req, res) => {
  try {
    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0]?.value;
    const message = change?.messages?.[0];

    if (message) {
      const from = message.from;
      const profileName = change?.contacts?.[0]?.profile?.name || "Friend";
      const text = (message.text?.body || "").trim().toLowerCase();

      if (text === "menu") {
        await sendText(
          from,
          `Hey ${profileName}!\n• Reply *YES* to opt in\n• Reply *STOP* to opt out\n• Send media to save it\n• Type *COUNT* to see subscribers`
        );
      } else if (text === "yes") {
        const store = readContacts();
        store.contacts[from] = {
          name: profileName,
          joinedAt: new Date().toISOString(),
        };
        writeContacts(store);
        await sendText(from, `Thanks ${profileName}! You are now subscribed ✅`);
      } else if (text === "stop") {
        const store = readContacts();
        delete store.contacts[from];
        writeContacts(store);
        await sendText(from, `You have been unsubscribed.`);
      } else if (text === "count") {
        const store = readContacts();
        await sendText(
          from,
          `Subscribers: ${Object.keys(store.contacts).length}`
        );
      } else if (text) {
        const store = readContacts();
        if (!store.contacts[from]) {
          await sendText(
            from,
            `Hi ${profileName}! Reply *YES* to join, or type *MENU* for options.`
          );
        } else {
          await sendText(from, `Got it! Type *MENU* for options.`);
        }
      }

      // Handle media
      if (["image", "video", "audio", "document", "sticker"].includes(message.type)) {
        try {
          const mediaId = message[message.type]?.id;
          if (mediaId) {
            const mediaUrl = await getMediaUrl(mediaId);
            const fileData = await axios.get(mediaUrl, {
              headers: { Authorization: `Bearer ${TOKEN}` },
              responseType: "arraybuffer",
            });
            const ext = getExt(fileData.headers["content-type"]);
            const fileName = `${mediaId}${ext}`;
            fs.writeFileSync(
              path.join(mediaDir, fileName),
              Buffer.from(fileData.data)
            );
            await sendText(from, `✅ Saved your ${message.type} as ${fileName}`);
          }
        } catch (err) {
          console.error("Media save error:", err.message);
          await sendText(from, "❌ Could not save that media right now.");
        }
      }
    }

    res.sendStatus(200);
  } catch (e) {
    console.error("Webhook error:", e);
    res.sendStatus(200);
  }
});

// Admin broadcast
app.post("/admin/broadcast", async (req, res) => {
  try {
    const { key, message } = req.body || {};
    if (key !== ADMIN_KEY) return res.status(401).json({ error: "Unauthorized" });
    if (!message) return res.status(400).json({ error: "Message required" });

    const store = readContacts();
    const waIds = Object.keys(store.contacts);
    let sent = 0;

    for (const wa of waIds) {
      await sendText(wa, message);
      sent++;
      await new Promise((r) => setTimeout(r, 250)); // gentle pacing
    }
    res.json({ ok: true, sent, total: waIds.length });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "server_error" });
  }
});

// Helpers
async function sendText(to, body) {
  await axios.post(
    `https://graph.facebook.com/v20.0/${PHONE_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body },
    },
    { headers: { Authorization: `Bearer ${TOKEN}` } }
  );
}

async function getMediaUrl(mediaId) {
  const meta = await axios.get(
    `https://graph.facebook.com/v20.0/${mediaId}`,
    { headers: { Authorization: `Bearer ${TOKEN}` } }
  );
  return meta.data.url;
}

function getExt(ct) {
  const map = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "video/mp4": ".mp4",
    "audio/mpeg": ".mp3",
    "application/pdf": ".pdf",
  };
  return map[ct] || "";
}

app.listen(PORT, () => console.log(`✅ Bot running on port ${PORT}`));
