// A7 消息边界（Round-2）：framed 恰好 maxMessageBytes 可落盘；+1 字节拒绝；
// 超过 1MiB 的 RPC 帧只断开肇事连接，不影响其他客户端与协调者。
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { TeamCoordinatorHost } from "../../../src/coord/host.js";
import { frameMessage } from "../../../src/domain/mailbox.js";
import { TeamError } from "../../../src/domain/errors.js";
import { RpcClient, readRpcToken } from "../../../src/coord/rpc.js";
import { discoverSocketPath } from "../../../src/coord/paths.js";

const TEAM = "sess_message_limit_lead";
const MAX_BYTES = 2_000;

let root: string;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "at-msg-limit-"));
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

async function openHost(teamId = TEAM): Promise<TeamCoordinatorHost> {
  return TeamCoordinatorHost.open({
    dataRoot: root,
    teamId,
    limits: { maxMembers: 8, maxTasks: 256, maxMessageBytes: MAX_BYTES, disposalTimeoutMs: 5_000 },
  });
}

/** framed JSON 的固定开销（纯 ASCII：文本每字符 1 字节，无转义）。 */
function framedOverhead(senderName: string): number {
  return JSON.stringify(
    frameMessage({ id: "x", senderId: "y", senderName, targetId: "z", content: [{ type: "text", text: "" }] }),
  ).length;
}

async function spawnWorker(host: TeamCoordinatorHost): Promise<void> {
  await host.dispatch("member.spawn", { session_id: TEAM, name: "worker", description: "d", prompt: "p" });
}

describe("A7 · 消息字节边界", () => {
  it("framed 恰好等于上限 → 接受；+1 字节 → TEAM_MESSAGE_TOO_LARGE", async () => {
    const host = await openHost();
    try {
      await spawnWorker(host);
      const overhead = framedOverhead("lead");
      expect(overhead).toBeLessThan(MAX_BYTES);

      const exact = [{ type: "text" as const, text: "a".repeat(MAX_BYTES - overhead) }];
      const exactBytes = JSON.stringify(
        frameMessage({ id: "x", senderId: "y", senderName: "lead", targetId: "z", content: exact }),
      ).length;
      expect(exactBytes).toBe(MAX_BYTES);

      const ok = (await host.dispatch("message.send", {
        session_id: TEAM,
        targetName: "worker",
        content: exact,
      })) as { messageId: string };
      expect(ok.messageId).toMatch(/^team-message-/);

      const over = [{ type: "text" as const, text: "a".repeat(MAX_BYTES - overhead + 1) }];
      await expect(
        host.dispatch("message.send", { session_id: TEAM, targetName: "worker", content: over }),
      ).rejects.toMatchObject({ code: "TEAM_MESSAGE_TOO_LARGE" });
    } finally {
      await host.close();
    }
  });

  it(
    ">1MiB 的 RPC 帧：断开肇事连接，其他客户端与协调者仍可用",
    async () => {
      const teamId = "sess_message_limit_oversize";
      const host = await openHost(teamId);
      try {
        await host.dispatch("member.spawn", { session_id: teamId, name: "worker", description: "d", prompt: "p" });
        const socketPath = discoverSocketPath(path.join(root, "teams", teamId));
        // 肇事连接：无换行 1.5MiB 帧（超过默认 1MiB 帧上限）
        const rogue = net.connect(socketPath);
        await new Promise<void>((resolve, reject) => {
          rogue.once("connect", () => resolve());
          rogue.once("error", reject);
        });
        rogue.on("error", () => undefined); // EPIPE 等由 close 断言覆盖
        rogue.write("x".repeat(1_500_000));
        const rogueClosed = await new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => resolve(false), 3000);
          rogue.once("close", () => {
            clearTimeout(timer);
            resolve(true);
          });
        });
        expect(rogueClosed).toBe(true);

        // 协调者未受影响：新客户端仍能正常调用（携带 host 写入的 rpc.token）。
        const token = readRpcToken(path.join(root, "teams", teamId));
        expect(token).toBeDefined();
        const client = await RpcClient.connect(socketPath, { token });
        try {
          const board = (await client.call<{ revision: number }>("board.read", {}, { timeoutMs: 3000 })) as {
            revision: number;
          };
          expect(board.revision).toBeGreaterThan(0);
        } finally {
          client.close();
        }
      } finally {
        await host.close();
      }
    },
    20_000,
  );

  it("TeamError 形状稳定：超限错误码属于 27 码集合", async () => {
    const host = await openHost("sess_message_limit_codes");
    try {
      await host.dispatch("member.spawn", {
        session_id: "sess_message_limit_codes",
        name: "worker",
        description: "d",
        prompt: "p",
      });
      const err = await host
        .dispatch("message.send", {
          session_id: "sess_message_limit_codes",
          targetName: "worker",
          content: [{ type: "text", text: "a".repeat(MAX_BYTES + 10) }],
        })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(TeamError);
      expect((err as TeamError).code).toBe("TEAM_MESSAGE_TOO_LARGE");
    } finally {
      await host.close();
    }
  });
});
