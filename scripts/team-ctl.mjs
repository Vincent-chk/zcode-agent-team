#!/usr/bin/env node
// team-ctl 薄启动器：核心逻辑在 src/cli/（构建产物 dist/team-ctl.mjs，由 build.mjs 生成）。
import { main } from "../dist/team-ctl.mjs";

const code = await main(process.argv.slice(2));
process.exit(code);
