import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { createGateways, GatewayError } from "../server/integrations.ts";

test("正常退出但仍有后台子进程时不得交付为成功", async () => {
  let group: number | undefined;
  const gateway = createGateways({
    probe: async () => ({ available: true, detail: "fixture" }),
    spawn: (_command, _args, options) => {
      const code = `const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setTimeout(()=>{},10000)'],{stdio:'ignore'});child.unref();console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'not actually finished'}}));process.exit(0)`;
      const child = spawn(process.execPath, ["-e", code], {
        ...options,
        stdio: ["pipe", "pipe", "pipe"],
      });
      group = child.pid;
      return child;
    },
    terminationGraceMs: 50,
    exitConfirmationMs: 1000,
  });
  try {
    await assert.rejects(
      gateway.executors.run({
        executor: "codex",
        workspace: tmpdir(),
        instruction: "",
        model: "",
        signal: new AbortController().signal,
      }),
      (error) =>
        error instanceof GatewayError && error.code === "UNKNOWN_PROCESS",
    );
  } finally {
    if (group) {
      try {
        process.kill(-group, "SIGKILL");
      } catch (error) {
        if (!(
          error instanceof Error &&
          "code" in error &&
          error.code === "ESRCH"
        ))
          throw error;
      }
    }
  }
});
