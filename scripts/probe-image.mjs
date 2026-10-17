
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildIdentityHeaders, deriveId, probeSession, resolveClientVersion } from "../src/identity.js";
import { applyToolQuartet } from "../src/tools.js";

const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
const KEY = JSON.parse(readFileSync(join(home, ".local", "share", "opencode", "auth.json"), "utf8")).opencode.key;
const { version } = resolveClientVersion();
const MODEL = process.argv[2] ?? "nemotron-3.5-super-vl-free";
const PNG_PATH = process.env.PROBE_PNG ?? join(process.env.TEMP ?? "/tmp", "testimg", "img256.b64");
const PNG = readFileSync(PNG_PATH, "utf8").trim();

const ENDPOINTS = {
  "/zen/v1": "https://opencode.ai/zen/v1/chat/completions",
};
const PROMPT = "what color is this image? answer with the color name only.";

function bodyFor(withImage) {
  const { tools } = applyToolQuartet([], { style: "chat", toolChoice: false });
  const content = withImage
    ? [{ type: "text", text: PROMPT }, { type: "image_url", image_url: { url: "data:image/png;base64," + PNG } }]
    : PROMPT;
  return { model: MODEL, messages: [{ role: "user", content }], stream: true, tools };
}

async function run(label, url, withImage) {
  const session = probeSession();
  const headers = buildIdentityHeaders({ version, session, requestId: deriveId("msg_", label + session), stream: true, apiKey: KEY });
  let res;
  try {
    res = await fetch(url, { method: "POST", headers, body: JSON.stringify(bodyFor(withImage)), signal: AbortSignal.timeout(180000) });
  } catch (error) { console.log(label.padEnd(40) + " -> 网络异常 " + (error?.message ?? error)); return; }
  if (!res.ok) { console.log(label.padEnd(40) + " -> HTTP " + res.status + "  " + (await res.text()).replace(/\s+/g, " ").slice(0, 140)); return; }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "", textOut = "", thinkOut = "", errFrame = null, frames = 0;
  while (frames < 80) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let cut;
    while ((cut = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      for (const line of frame.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const p = line.slice(5).trim();
        if (p === "" || p === "[DONE]") continue;
        frames += 1;
        try {
          const j = JSON.parse(p);
          if (j.error) errFrame = JSON.stringify(j.error).slice(0, 150);
          const d = j?.choices?.[0]?.delta;
          if (typeof d?.content === "string") textOut += d.content;
          if (typeof d?.reasoning_content === "string") thinkOut += d.reasoning_content;
        } catch {}
      }
    }
  }
  await reader.cancel().catch(() => {});
  const verdict = errFrame !== null ? "流内错误: " + errFrame : "正文=" + textOut.length + " 思考=" + thinkOut.length;
  console.log(label.padEnd(40) + " -> 200 帧=" + frames + " " + verdict);
  if (textOut.length > 0) console.log("     正文: " + JSON.stringify(textOut.slice(0, 300)));
  if (thinkOut.length > 0) console.log("     思考尾: " + JSON.stringify(thinkOut.slice(-260)));
}

console.log("模型: " + MODEL);
console.log("图片: " + PNG_PATH + " (" + PNG.length + " base64 字符)\n");
for (const [name, url] of Object.entries(ENDPOINTS)) {
  await run(name + " 纯文本", url, false);
  await new Promise((r) => setTimeout(r, 700));
  await run(name + " 文本+图片", url, true);
  await new Promise((r) => setTimeout(r, 700));
}
