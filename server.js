import "dotenv/config";
import app from "./app.js";

const port = Number(process.env.PORT || 3000);
app.listen(port, "0.0.0.0", () => {
  console.log(`NovelVoice AI server listening on port ${port}`);
  console.log(`Premium narration: ${process.env.OPENAI_API_KEY ? "configured" : "not configured (browser narration remains available)"}`);
});
