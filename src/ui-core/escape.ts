// HTML 转义（文案/id/描述全部经此，杜绝注入）。独立模块：render.ts 与 member-settings.ts
// 互相引用会形成循环依赖，转义函数下沉后两处共用同一实现（render.ts 仍 re-export 兼容）。
export function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
