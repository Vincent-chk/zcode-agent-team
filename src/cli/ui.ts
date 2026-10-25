// team-ctl transcript / widget（stage-5 T5.7 CLI 对等 + T5.3 降级链；纯函数可单测）。
// transcript = 面板 detail 同一合成函数（src/panel/detail.ts，不写第二实现；F12）；
// widget = ::visualize 快照卡片片段 / standalone 静态页（ui-core/widget.ts 同源渲染）。

import fs from "node:fs";
import path from "node:path";
import type { LoadedTeam } from "../coord/replay.js";
import { TranscriptReader } from "../provider/transcript.js";
import { buildDetail, renderDetailText, type DetailMode, type DetailResult } from "../panel/detail.js";
import { buildStaticFrame, resolveMemberSession } from "../panel/view-service.js";
import { renderStandalonePage, renderWidgetFragment } from "../ui-core/widget.js";
import type { Lang } from "../ui-core/dict.js";

/** teamDir = <dataRoot>/teams/<id> → dataRoot 上推两级（session-map 反查用）。 */
function dataRootOf(teamDir: string): string {
  return path.dirname(path.dirname(path.resolve(teamDir)));
}

export interface TranscriptInput {
  teamDir: string;
  teamId: string;
  loaded: LoadedTeam;
  member: string;
  json: boolean;
  cursor?: number;
  limit?: number;
  /** detail 视图模式（缺省 summary；与面板 detail 同契约）。 */
  mode?: DetailMode;
  /** db 探针注入（测试夹具库；缺省 = 生产 db.sqlite）。 */
  dbPath?: string;
}

/** 成员会话查看流（合成 + 文本/JSON 输出；错误经抛错由 main 单行化）。 */
export function renderTranscript(input: TranscriptInput): string {
  const reader = new TranscriptReader(input.dbPath !== undefined ? { dbPath: input.dbPath } : {});
  let result: DetailResult;
  let name = input.member;
  try {
    result = buildDetail(
      { teamDir: input.teamDir, teamId: input.teamId, state: input.loaded.state, reader },
      {
        target: input.member,
        ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
        ...(input.mode !== undefined ? { mode: input.mode } : {}),
      },
      (memberId) => resolveMemberSession(input.teamDir, dataRootOf(input.teamDir), memberId),
    );
    const member = input.loaded.state.members.find((m) => m.id === result.memberId || m.name === input.member);
    if (member !== undefined) name = member.name;
    if (input.member === "lead" || input.member === input.teamId) name = "lead";
  } finally {
    reader.close();
  }
  if (input.json) return JSON.stringify({ ...result, memberName: name }, null, 2);
  return renderDetailText(result, name);
}

export interface WidgetInput {
  teamDir: string;
  teamId: string;
  loaded: LoadedTeam;
  theme: "light" | "dark";
  lang: Lang;
  standalone: boolean;
  out?: string;
  sessionId?: string;
}

/** 快照卡片/静态页产出（内嵌当前重放视图；--out 落盘，否则 stdout）。 */
export function renderWidget(input: WidgetInput): { html: string; out?: string } {
  const frame = buildStaticFrame(
    input.loaded,
    input.teamId,
    new Date().toISOString(),
    input.sessionId,
    input.teamDir,
    dataRootOf(input.teamDir),
  );
  const html = input.standalone
    ? renderStandalonePage({ frame, lang: input.lang, theme: input.theme })
    : renderWidgetFragment({ frame, lang: input.lang, theme: input.theme });
  if (input.out !== undefined) {
    const abs = safeOutPath(input.out);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, html);
    return { html, out: abs };
  }
  return { html };
}

/**
 * --out 目标校验（防路径穿越）：拒绝含 `..` 段的输入；basename 白名单 [A-Za-z0-9._-]
 * 且必须 .html 后缀；返回 resolve 后的绝对路径（CLI 显式输出语义保留：绝对/相对皆可）。
 */
export function safeOutPath(out: string): string {
  if (out.split(/[\\/]/).includes("..")) {
    throw new Error(`--out 拒绝路径穿越段 ".."：${out}`);
  }
  const abs = path.resolve(out);
  const base = path.basename(abs);
  if (!/^[A-Za-z0-9._-]+\.html$/.test(base)) {
    throw new Error(`--out 文件名须为白名单字符且 .html 后缀（[A-Za-z0-9._-]）：${base}`);
  }
  return abs;
}
