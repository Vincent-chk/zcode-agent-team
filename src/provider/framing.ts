// 框架化消息 → 轮次 prompt 文本（provider 与 hooks 共用；接口草案 §4 模板）。
// framed JSON（mailbox.frameMessage 产物）= [{type:"text",text:"Team message from <name>:"}, ...原内容块]。
// 渲染规则（D1/D12）：
//  - 框架头逐字一行（无消息 id——内部 messageId 只留在事件/轮次记录层，不进模型可见文本）；
//  - text 块每块一行；非 text 块以单行 JSON 序列化（保序）；
//  - 多条消息以空行分隔（模型可分辨每条消息边界与发送者，F06b 口径）。

export interface FramedText {
  messageId: string;
  senderName: string;
  text: string;
}

/** 单条 framed JSON → 文本渲染。 */
export function renderFramed(framedJson: string): FramedText {
  const blocks = JSON.parse(framedJson) as Array<{ type?: string; text?: unknown }>;
  if (!Array.isArray(blocks) || blocks.length === 0) {
    throw new Error("framed message must be a non-empty JSON array of content blocks");
  }
  const header = blocks[0];
  if (header.type !== "text" || typeof header.text !== "string") {
    throw new Error("framed message first block must be the text header");
  }
  const m = header.text.match(/^Team message from (.+):$/);
  if (m === null) {
    throw new Error(`framed message header mismatch: ${JSON.stringify(header.text)}`);
  }
  const lines: string[] = [header.text];
  for (const block of blocks.slice(1)) {
    if (block.type === "text" && typeof block.text === "string") {
      lines.push(block.text);
    } else {
      lines.push(JSON.stringify(block));
    }
  }
  return { messageId: "", senderName: m[1], text: lines.join("\n") };
}

/** 多条 framed 渲染并合并为一轮 prompt（队列序；每条保留自己的框架头）。 */
export function renderFramedBatch(items: ReadonlyArray<{ messageId: string; framedJson: string }>): {
  promptText: string;
  rendered: FramedText[];
} {
  const rendered = items.map((item) => ({ ...renderFramed(item.framedJson), messageId: item.messageId }));
  return { promptText: rendered.map((r) => r.text).join("\n\n"), rendered };
}

/** 三通道注入文本（接口草案 §4 冻结模板：[agent-team inbox] + 逐条框架化文本）。 */
export function buildInboxContext(framedTexts: ReadonlyArray<string>): string {
  const body = framedTexts.join("\n\n");
  return `[agent-team inbox] 待收消息 ${framedTexts.length} 条：\n${body}`;
}
