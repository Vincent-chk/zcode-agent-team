// team-ctl open-panel（stage-5 T5.5 伴生面板入口）：读 logs/panel-http.json 注册文件 →
// 打印/打开伴生面板 URL。注册文件由 daemon（TEAM_COMPANION=1）写入，含 127.0.0.1 随机端口
// + 会话 token（0600 权限；无凭据字面量——token 由 daemon 运行时生成）。
// 无注册文件 / 端口探测失败 → 可读指引（提示以 TEAM_COMPANION=1 启动 daemon）。
// 路径纪律：注册文件路径经 companionRegistryFile()（companion-server.ts）做 dataRoot
// 包含性校验后才读盘——无未校验的动态路径片段进入文件读取。
// 网络纪律：仅打印/打开回环 URL（不向该 URL 发起 HTTP 请求，交浏览器；端口探活走
// net.connect 固定 127.0.0.1 + 注册端口，无用户可控主机名）。

import fs from "node:fs";
import net from "node:net";
import { execFile } from "node:child_process";
import { companionRegistryFile } from "../panel/companion-server.js";
import { dataDir } from "../shared.js";

export interface OpenPanelInput {
  /** 数据目录（缺省 = dataDir()，与 daemon 同源）。 */
  dataRoot?: string;
  /** 只打印 URL，不调用系统浏览器。 */
  noOpen?: boolean;
}

export interface OpenPanelResult {
  ok: boolean;
  url?: string;
  port?: number;
  message: string;
}

const NOT_RUNNING =
  "伴生面板未运行（无 logs/panel-http.json）。以 TEAM_COMPANION=1 启动 team-daemon 后重试" +
  "（MCP Apps 面板/::visualize 卡片为主载体，伴生面板为可选高保真路径）。";

/** 读注册文件（无/损坏/端口未监听 → ok:false + 可读指引）。 */
export async function openPanel(input: OpenPanelInput = {}): Promise<OpenPanelResult> {
  const registryFile = companionRegistryFile(input.dataRoot ?? dataDir());
  let reg: { port?: unknown; token?: unknown };
  try {
    reg = JSON.parse(fs.readFileSync(registryFile, "utf8")) as typeof reg;
  } catch {
    return { ok: false, message: NOT_RUNNING };
  }
  if (
    typeof reg.port !== "number" ||
    !Number.isInteger(reg.port) ||
    reg.port < 1 ||
    reg.port > 65535 ||
    typeof reg.token !== "string" ||
    !/^[0-9a-f]{32}$/.test(reg.token)
  ) {
    return { ok: false, message: "logs/panel-http.json 内容非法（port/token 校验失败）。" };
  }
  const url = `http://127.0.0.1:${reg.port}/panel?token=${reg.token}`;
  // 端口探活（避免打印死链）；探测超时按可达处理（浏览器自理重连）
  const alive = await probePort(reg.port);
  if (!alive) {
    return {
      ok: false,
      port: reg.port,
      message: `伴生面板端口 ${reg.port} 未监听（daemon 可能已回收）。以 TEAM_COMPANION=1 重启 daemon 后重试。`,
    };
  }
  if (input.noOpen !== true) void launchBrowser(url);
  return { ok: true, url, port: reg.port, message: url };
}

function probePort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.setTimeout(1500);
    socket.once("timeout", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

/** 系统浏览器打开（macOS open / win start / 其余 xdg-open；execFile 固定命令 + 参数数组）。 */
function launchBrowser(url: string): Promise<void> {
  const platform = process.platform;
  const [cmd, args] =
    platform === "darwin"
      ? (["open", [url]] as const)
      : platform === "win32"
        ? (["cmd", ["/c", "start", "", url]] as const)
        : (["xdg-open", [url]] as const);
  return new Promise((resolve) => {
    execFile(cmd, [...args], { windowsHide: true }, () => resolve());
  });
}
