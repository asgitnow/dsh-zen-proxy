/**
 * harness 消息 → 两种上游 wire 请求体。
 *
 * 输入的 `messages` 是宿主 `@deepseek-ai/dsh-llm` 的持久消息形状
 * （`{id, role, content: ContentBlock[], source, toolCallId?, isError?}`），
 * 内容块类型包含 `text`、`reasoning`、`tool-call`（`arguments` 为原始 JSON 字符串）。
 * `image` 与 `file` 块不需要处理：目录里每个模型都声明 `inputModalities: ['text']`，
 * 宿主在分发前已把它们投影成文本占位符。
 *
 * 输出为两条上游协议族的请求体：
 * - chat：`POST /zen/v1/chat/completions`，`messages` + 嵌套 `tools[{type:'function',function:{…}}]`
 * - responses：`POST /zen/v1/responses`，`input` 扁平 item 列表 + 扁平 `tools[{type:'function',name,…}]`
 *
 * 两者都强制 `stream: true`（spec 的「闸门要求的请求形状」）。
 * **本模块不发明输出上限**：只把调用方给出的正整数 `maxTokens` 写成 `max_tokens` /
 * `max_output_tokens`；具体取值由 `src/effort.js` 的 `budgetFor` 按思考档位折算，本模块
 * 不做档位推断（本变更后适配器总是传入一个不小于下界的正整数，因此线上恒带预算）。
 *
 * 本模块是**宿主无关的纯逻辑**：不 import 任何 `@deepseek-ai/*` 包。
 *
 * @module src/messages.js
 */

/**
 * 拼接内容块里的文本。
 * @param {unknown} content
 * @returns {string}
 */
export function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let text = '';
  for (const block of content) {
    if (typeof block === 'string') { text += block; continue; }
    if (block?.type === 'text' && typeof block.text === 'string') text += block.text;
  }
  return text;
}

function toolCallsOf(content) {
  if (!Array.isArray(content)) return [];
  return content.filter((block) => block?.type === 'tool-call');
}

/**
 * 收集消息里出现过的图片引用（按首次出现顺序去重）。
 *
 * 宿主的 `ImageBlock` 不带字节，只有 `attachment` 引用；字节由调用方经
 * `attachments.readImageRequest()` 异步取出后，以 `attachmentId → data URL` 的
 * Map 交给本模块的构造函数。
 *
 * @param {unknown} messages
 * @returns {object[]}
 */
export function imageRefsOf(messages) {
  const refs = new Map();
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!Array.isArray(message?.content)) continue;
    for (const block of message.content) {
      if (block?.type !== 'image') continue;
      const id = block.attachment?.attachmentId;
      if (typeof id === 'string' && id !== '') refs.set(id, block.attachment);
    }
  }
  return [...refs.values()];
}

/**
 * 组装 user 轮的 chat content：无图片时是纯字符串，有图片时是 parts 数组。
 * @param {unknown} content
 * @param {Map<string, string> | undefined} images `attachmentId → data URL`
 * @returns {string | object[]}
 */
function chatUserContent(content, images) {
  if (!Array.isArray(content)) return typeof content === 'string' ? content : '';
  let text = '';
  const parts = [];
  for (const block of content) {
    if (typeof block === 'string') { text += block; continue; }
    if (block?.type === 'text' && typeof block.text === 'string') { text += block.text; continue; }
    if (block?.type !== 'image') continue;
    const url = images?.get(block.attachment?.attachmentId);
    // 取不到字节就不发该块：宁缺勿发一个上游必然拒绝的形状。
    if (typeof url !== 'string') continue;
    parts.push({ type: 'image_url', image_url: { url } });
  }
  if (parts.length === 0) return text;
  return text === '' ? parts : [{ type: 'text', text }, ...parts];
}

/**
 * 组装 user 轮的 responses content：无图片时是单个 `input_text`。
 * @param {unknown} content
 * @param {Map<string, string> | undefined} images `attachmentId → data URL`
 * @returns {object[]}
 */
function responsesUserContent(content, images) {
  if (!Array.isArray(content)) {
    const text = typeof content === 'string' ? content : '';
    return text === '' ? [] : [{ type: 'input_text', text }];
  }
  let text = '';
  const images_ = [];
  for (const block of content) {
    if (typeof block === 'string') { text += block; continue; }
    if (block?.type === 'text' && typeof block.text === 'string') { text += block.text; continue; }
    if (block?.type !== 'image') continue;
    const url = images?.get(block.attachment?.attachmentId);
    if (typeof url !== 'string') continue;
    images_.push({ type: 'input_image', image_url: url });
  }
  const parts = text === '' ? [] : [{ type: 'input_text', text }];
  return [...parts, ...images_];
}

function positiveLimit(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function limitFields(wire, maxTokens) {
  const limit = positiveLimit(maxTokens);
  if (limit === undefined) return {};
  return wire === 'responses' ? { max_output_tokens: limit } : { max_tokens: limit };
}

function samplingFields(wire, { temperature, stop }) {
  const fields = {};
  if (typeof temperature === 'number' && Number.isFinite(temperature)) fields.temperature = temperature;
  // responses 协议族不接受 chat 形状的 `stop`，省略而不是改写。
  if (wire === 'chat' && Array.isArray(stop) && stop.length > 0) fields.stop = [...stop];
  return fields;
}

/**
 * 构造 chat 协议族的 `messages` 数组。
 * @param {unknown} messages
 * @param {Map<string, string> | undefined} [images] `attachmentId → data URL`
 * @returns {object[]}
 */
export function chatMessages(messages, images) {
  const out = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    if (typeof message !== 'object' || message === null) continue;
    const text = textOf(message.content);
    switch (message.role) {
      case 'system':
      case 'developer':
        if (text !== '') out.push({ role: 'system', content: text });
        break;
      case 'user': {
        const content = chatUserContent(message.content, images);
        const empty = content === '' || (Array.isArray(content) && content.length === 0);
        if (!empty) out.push({ role: 'user', content });
        break;
      }
      case 'assistant': {
        const calls = toolCallsOf(message.content);
        if (text === '' && calls.length === 0) break;
        out.push({
          role: 'assistant',
          content: text,
          ...calls.length === 0 ? {} : {
            tool_calls: calls.map((block, index) => ({
              id: typeof block.id === 'string' && block.id !== '' ? block.id : `call_${index}`,
              type: 'function',
              function: {
                name: typeof block.name === 'string' ? block.name : '',
                // 工具参数保持原始 JSON 字符串，绝不重新序列化。
                arguments: typeof block.arguments === 'string' ? block.arguments : '{}',
              },
            })),
          },
        });
        break;
      }
      case 'tool':
        out.push({
          role: 'tool',
          tool_call_id: typeof message.toolCallId === 'string' ? message.toolCallId : '',
          content: text,
        });
        break;
      default:
        break;
    }
  }
  return out;
}

/**
 * 构造 responses 协议族的 `input` item 列表。
 * @param {unknown} messages
 * @returns {object[]}
 */
export function responsesInput(messages, images) {
  const out = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    if (typeof message !== 'object' || message === null) continue;
    const text = textOf(message.content);
    switch (message.role) {
      case 'system':
      case 'developer':
        if (text !== '') out.push({ type: 'message', role: 'system', content: [{ type: 'input_text', text }] });
        break;
      case 'user': {
        const content = responsesUserContent(message.content, images);
        if (content.length > 0) out.push({ type: 'message', role: 'user', content });
        break;
      }
      case 'assistant': {
        if (text !== '') out.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
        for (const [index, block] of toolCallsOf(message.content).entries()) {
          out.push({
            type: 'function_call',
            call_id: typeof block.id === 'string' && block.id !== '' ? block.id : `call_${index}`,
            name: typeof block.name === 'string' ? block.name : '',
            arguments: typeof block.arguments === 'string' ? block.arguments : '{}',
          });
        }
        break;
      }
      case 'tool':
        out.push({
          type: 'function_call_output',
          call_id: typeof message.toolCallId === 'string' ? message.toolCallId : '',
          output: text,
        });
        break;
      default:
        break;
    }
  }
  return out;
}

/**
 * 构造一次 chat 协议族请求体。
 * @param {{model: string, messages?: unknown, tools?: object[], toolChoice?: string,
 *          maxTokens?: number, temperature?: number, stop?: string[]}} input
 * @returns {object}
 */
export function buildChatRequest({ model, messages, tools, toolChoice, maxTokens, temperature, stop, images }) {
  const body = {
    model,
    messages: chatMessages(messages, images),
    stream: true,
    tools: Array.isArray(tools) ? tools : [],
    ...limitFields('chat', maxTokens),
    ...samplingFields('chat', { temperature, stop }),
  };
  if (typeof toolChoice === 'string') body.tool_choice = toolChoice;
  return body;
}

/**
 * 构造一次 responses 协议族请求体。
 * @param {{model: string, messages?: unknown, tools?: object[], toolChoice?: string,
 *          maxTokens?: number, temperature?: number, images?: Map<string,string>}} input
 * @returns {object}
 */
export function buildResponsesRequest({ model, messages, tools, toolChoice, maxTokens, temperature, images }) {
  const body = {
    model,
    input: responsesInput(messages, images),
    stream: true,
    store: false,
    tools: Array.isArray(tools) ? tools : [],
    ...limitFields('responses', maxTokens),
    ...samplingFields('responses', { temperature }),
  };
  if (typeof toolChoice === 'string') body.tool_choice = toolChoice;
  return body;
}

/**
 * 按协议族构造请求体。
 * @param {'chat' | 'responses'} wire
 * @param {object} input 见 {@link buildChatRequest} / {@link buildResponsesRequest}
 * @returns {object}
 */
export function buildRequestFor(wire, input) {
  return wire === 'responses' ? buildResponsesRequest(input) : buildChatRequest(input);
}
