// vitest 配置：src/domain/**（第一轮）+ src/coord/**（第二轮）+ src/cli/**（第四轮）
// + src/mcp/**（stage-3 工具面）+ src/ui-core/** + src/panel/**（stage-5 UI 面）纳入覆盖率门槛；
// 演练类测试涉及真实子进程与时序断言 → 关闭文件级并行，避免计时抖动。
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // exFAT 外置卷会为每个文件生成 AppleDouble 元数据（._*），必须排除，否则被当作测试源
    exclude: ["**/node_modules/**", "**/.git/**", "**/dist/**", "**/._*"],
    environment: "node",
    fileParallelism: false,
    testTimeout: 15_000,
    coverage: {
      provider: "v8",
      include: ["src/domain/**", "src/coord/**", "src/provider/**", "src/cli/**", "src/mcp/**", "src/hooks/**", "src/ui-core/**", "src/panel/**"],
      // detach-helper.mjs = 独立子进程资产（经集成测试覆盖，进程内不可插桩）；
      // teammate-provider.ts = 纯类型声明（无执行语句）；
      // panel/main.ts + panel/companion-main.ts + ui-core/expand.ts = 浏览器专属载体
      // （iife bundle / DOM+ResizeObserver，node 环境不可插桩；覆盖 = T5.6 视觉回归 DOM 断言
      // + scripts/f10-companion.mjs 交互矩阵 + 裸浏览器降级烟测 + stage-5/6 实机验收）
      exclude: [
        "**/._*",
        "**/*.mjs",
        "src/provider/teammate-provider.ts",
        "src/panel/main.ts",
        "src/panel/companion-main.ts",
        "src/ui-core/expand.ts",
      ],
      thresholds: {
        statements: 90,
        lines: 90,
        functions: 90,
        branches: 85,
      },
    },
  },
});
