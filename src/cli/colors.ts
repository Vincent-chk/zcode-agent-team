// ANSI 着色（team-ctl）：非 TTY 或 NO_COLOR → 纯文本降级。
import type { WriteStream } from "node:tty";

export interface Paint {
  enabled: boolean;
  cyan(text: string): string;
  yellow(text: string): string;
  magenta(text: string): string;
  green(text: string): string;
  red(text: string): string;
  bold(text: string): string;
  dim(text: string): string;
}

export function paintFor(stream: { isTTY?: boolean }): Paint {
  // 常规：TTY 且无 NO_COLOR；FORCE_COLOR=1 强制启用（管道/演示场景）
  const enabled = process.env.FORCE_COLOR === "1" || (stream.isTTY === true && process.env.NO_COLOR === undefined);
  const wrap =
    (code: string) =>
    (text: string): string =>
      enabled ? `\x1b[${code}m${text}\x1b[0m` : text;
  return {
    enabled,
    cyan: wrap("36"),
    yellow: wrap("33"),
    magenta: wrap("35"),
    green: wrap("32"),
    red: wrap("31"),
    bold: wrap("1"),
    dim: wrap("2"),
  };
}

export function paintForStream(stream: WriteStream | NodeJS.WriteStream): Paint {
  return paintFor({ isTTY: (stream as { isTTY?: boolean }).isTTY });
}
