import express from "express";
import OpenAI from "openai";
import path from "node:path";
import { fileURLToPath } from "node:url";

const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public"), { maxAge: process.env.NODE_ENV === "production" ? "1h" : 0 }));

// Lightweight per-process rate limit. Use a shared store (for example Redis)
// if you run multiple server instances in production.
const rateBuckets = new Map();
function rateLimit({ windowMs, max, message }) {
  return (req, res, next) => {
    const key = `${req.path}:${req.ip}`;
    const now = Date.now();
    for (const [oldKey, oldBucket] of rateBuckets) {
      if (now - oldBucket.start > 60 * 60 * 1000) rateBuckets.delete(oldKey);
    }
    let bucket = rateBuckets.get(key);
    if (!bucket || now - bucket.start >= windowMs) bucket = { start: now, count: 0 };
    bucket.count += 1;
    rateBuckets.set(key, bucket);
    if (bucket.count > max) return res.status(429).send(message);
    next();
  };
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "novelvoice-ai", premiumNarrationConfigured: Boolean(process.env.OPENAI_API_KEY) });
});

app.post("/api/tts", rateLimit({ windowMs: 60_000, max: 20, message: "Too many narration requests. Please wait a minute and try again." }), async (req, res) => {
  try {
    if (!process.env.OPENAI_API_KEY) {
      return res.status(503).send("Premium narration is not configured. Add OPENAI_API_KEY to your .env file.");
    }
    const { text, voice = "marin", speed = 1, instructions = "Read clearly and naturally.", characters = [] } = req.body || {};
    if (typeof text !== "string" || !text.trim()) return res.status(400).send("Text is required.");
    if (text.length > 4096) return res.status(413).send("Text chunk is too long. Please use the app's chapter generator.");
    const allowed = new Set(["alloy","ash","ballad","coral","echo","fable","marin","nova","onyx","sage","shimmer","verse","cedar"]);
    if (!allowed.has(voice)) return res.status(400).send("Unsupported voice.");
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const safeSpeed = Math.max(0.25, Math.min(4, Number(speed) || 1));
    // The voice API receives only the text and style selected by the user.
    // Character profiles are currently a UI/planning feature; automatic diarization
    // and per-speaker synthesis require a separate speaker-detection pipeline.
    const response = await client.audio.speech.create({
      model: process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts",
      voice,
      input: text,
      instructions: String(instructions).slice(0, 900),
      speed: safeSpeed,
      response_format: "mp3"
    });
    const buffer = Buffer.from(await response.arrayBuffer());
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Content-Disposition", 'attachment; filename="novelvoice.mp3"');
    res.setHeader("Cache-Control", "no-store");
    res.send(buffer);
  } catch (error) {
    console.error("TTS error:", error?.message || error);
    res.status(error?.status || 500).send(error?.message || "Speech generation failed.");
  }
});


// Public-domain novel discovery powered by the Gutendex catalogue API.
app.get("/api/catalog/search", async (req, res) => {
  try {
    const q = String(req.query.q || "").trim().slice(0, 160);
    if (!q) return res.status(400).send("Search query is required.");
    const url = new URL("https://gutendex.com/books/");
    url.searchParams.set("search", q);
    url.searchParams.set("page", "1");
    const response = await fetch(url, { headers: { "Accept": "application/json" } });
    if (!response.ok) return res.status(502).send("The public-domain catalogue is temporarily unavailable.");
    const data = await response.json();
    res.json({
      count: data.count || 0,
      results: (data.results || []).slice(0, 12).map(book => ({
        id: book.id,
        title: book.title,
        authors: (book.authors || []).map(a => ({ name: a.name })),
        subjects: (book.subjects || []).slice(0, 3)
      }))
    });
  } catch (error) {
    res.status(502).send("Could not search the public-domain catalogue.");
  }
});

app.get("/api/catalog/book/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) return res.status(400).send("Invalid book ID.");
    const metaResponse = await fetch(`https://gutendex.com/books/${id}`);
    if (!metaResponse.ok) return res.status(404).send("Book not found in the catalogue.");
    const meta = await metaResponse.json();
    const formats = meta.formats || {};
    const textUrl = formats["text/plain; charset=utf-8"] ||
      formats["text/plain; charset=us-ascii"] ||
      formats["text/plain"];
    if (!textUrl) return res.status(415).send("This book has no plain-text download in the catalogue.");
    const parsed = new URL(textUrl);
    // Only fetch Gutenberg-hosted plain-text book files to prevent arbitrary URL fetching.
    if (!["www.gutenberg.org", "gutenberg.org"].includes(parsed.hostname) ||
        !/^https?:$/.test(parsed.protocol)) {
      return res.status(400).send("The catalogue returned an unsupported download host.");
    }
    const textResponse = await fetch(parsed, { headers: { "Accept": "text/plain" } });
    if (!textResponse.ok) return res.status(502).send("Could not download the book text.");
    const raw = await textResponse.text();
    if (raw.length > 12 * 1024 * 1024) return res.status(413).send("This book file is too large to import.");
    const start = raw.search(/\*\*\*\s*START OF (?:THE|THIS) PROJECT GUTENBERG EBOOK/i);
    const end = raw.search(/\*\*\*\s*END OF (?:THE|THIS) PROJECT GUTENBERG EBOOK/i);
    const clean = start >= 0 ? raw.slice(raw.indexOf("\n", start) + 1, end > start ? end : undefined) : raw;
    res.json({ id, title: meta.title || "Imported novel", text: clean });
  } catch (error) {
    console.error("Catalogue import error:", error?.message || error);
    res.status(502).send("Could not import this catalogue book.");
  }
});


// Best-effort extraction from public webpages via Jina Reader.
// This does not log into sites, bypass paywalls/DRM, or evade site access controls.
app.post("/api/extract-url", rateLimit({ windowMs: 60_000, max: 30, message: "Too many page-import requests. Please wait a minute and try again." }), async (req, res) => {
  try {
    const raw = String(req.body?.url || "").trim();
    if (!raw || raw.length > 2048) return res.status(400).send("A valid webpage URL is required.");
    let target;
    try { target = new URL(raw); } catch { return res.status(400).send("The webpage URL is invalid."); }
    if (!["http:", "https:"].includes(target.protocol)) return res.status(400).send("Only HTTP and HTTPS webpages are supported.");
    if (target.username || target.password) return res.status(400).send("URLs containing embedded credentials are not supported.");
    const host = target.hostname.toLowerCase();
    const blockedHosts = new Set(["localhost", "localhost.localdomain", "127.0.0.1", "::1", "0.0.0.0"]);
    if (blockedHosts.has(host) || host.endsWith(".local") || host.endsWith(".internal")) {
      return res.status(400).send("Private and local network addresses cannot be imported.");
    }
    // The extraction provider retrieves the public URL; the app never attempts to authenticate.
    const readerUrl = "https://r.jina.ai/" + target.href;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 35000);
    let response;
    try {
      response = await fetch(readerUrl, {
        signal: controller.signal,
        headers: { "Accept": "text/plain", "X-Return-Format": "markdown" }
      });
    } finally { clearTimeout(timeout); }
    if (!response.ok) return res.status(502).send("The page reader could not extract this page (status " + response.status + ").");
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text/") && !contentType.includes("application/json")) {
      return res.status(415).send("The page reader did not return readable text.");
    }
    const body = await response.text();
    if (!body.trim()) return res.status(422).send("No readable text was found on this page.");
    if (body.length > 1_500_000) return res.status(413).send("Extracted page is too large. Import individual chapters instead.");
    // Strip common reader metadata while retaining the actual page text and headings.
    const lines = body.split(/\r?\n/);
    let title = target.hostname;
    const titleLine = lines.find(line => /^title:\s*/i.test(line));
    if (titleLine) title = titleLine.replace(/^title:\s*/i, "").trim().slice(0, 180);
    let text = body
      .replace(/^URL Source:.*$/gim, "")
      .replace(/^Title:.*$/gim, "")
      .replace(/^Markdown Content:?\s*$/gim, "")
      .replace(/^Warning:.*$/gim, "")
      .trim();
    if (text.length < 80) return res.status(422).send("The page did not contain enough readable novel text.");
    res.json({ title, text, source: target.hostname });
  } catch (error) {
    const message = error?.name === "AbortError" ? "Page extraction timed out." : "Could not extract this public webpage.";
    res.status(502).send(message);
  }
});


export default app;
