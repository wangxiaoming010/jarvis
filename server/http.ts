import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { z } from "zod";
import {
  CreateEmployee,
  CreateConversation,
  SendMessage,
  CreateTask,
  TaskAction,
  SaveModel,
  SaveExecution,
  CreateMemory,
  CreateRule,
  Id,
  PROVIDERS,
} from "../shared/domain.ts";
import { Workspace, WorkspaceError } from "./workspace.ts";
import { log } from "./log.ts";
import { UpdateEmployee } from "../shared/relay.ts";

type Options = {
  workspace: Workspace;
  origin: string;
  distDir: string;
  bootstrapToken: string;
};
class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};
function equalToken(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
async function body(request: IncomingMessage): Promise<unknown> {
  if (!request.headers["content-type"]?.startsWith("application/json"))
    throw new HttpError(415, "CONTENT_TYPE", "请求必须使用 JSON。");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > 256 * 1024)
      throw new HttpError(413, "BODY_TOO_LARGE", "请求内容过大。");
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "INVALID_JSON", "JSON 格式错误。");
  }
}
function json(response: ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(value));
}

export function createHttpServer(options: Options) {
  const { workspace, origin, distDir } = options;
  const host = new URL(origin).host;
  const cookieName = `jarvis_local_${new URL(origin).port}`;
  const sessions = new Map<string, number>();
  let bootstrapUsed = false;
  let failedLogins = 0;
  let loginWindow = Date.now();
  const authenticate = (request: IncomingMessage): boolean => {
    const token = (request.headers.cookie || "")
      .split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith(`${cookieName}=`))
      ?.slice(cookieName.length + 1);
    if (!token) return false;
    const expires = sessions.get(token);
    if (!expires || expires < Date.now()) {
      sessions.delete(token);
      return false;
    }
    return true;
  };
  const server = createServer(async (request, response) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    );
    try {
      if (request.headers.host !== host)
        throw new HttpError(403, "HOST_REJECTED", "仅允许本机工作台地址。");
      const method = request.method || "GET";
      const pathname = decodeURIComponent(
        new URL(request.url || "/", origin).pathname,
      );
      const api = pathname.startsWith("/api/");
      if (api && method !== "GET") {
        if (
          request.headers.origin !== origin ||
          request.headers["x-jarvis-request"] !== "1"
        )
          throw new HttpError(403, "ORIGIN_REJECTED", "请求来源校验失败。");
      }
      if (method === "GET" && pathname === "/api/mode")
        return json(response, { mode: "local" });
      if (method === "GET" && pathname === "/api/health")
        return json(response, { ok: true });
      if (method === "POST" && pathname === "/api/session") {
        const input = z
          .object({ token: z.string().max(512) })
          .parse(await body(request));
        if (authenticate(request)) return json(response, { ok: true });
        if (Date.now() - loginWindow > 60000) {
          failedLogins = 0;
          loginWindow = Date.now();
        }
        if (failedLogins >= 10)
          throw new HttpError(429, "LOGIN_LIMIT", "尝试过多，请稍后再试。");
        if (bootstrapUsed || !equalToken(input.token, options.bootstrapToken)) {
          failedLogins++;
          throw new HttpError(
            401,
            "INVALID_TOKEN",
            "本机登录凭据无效或已使用，请通过启动器重新打开。",
          );
        }
        bootstrapUsed = true;
        const token = randomBytes(32).toString("hex");
        sessions.set(token, Date.now() + 12 * 60 * 60 * 1000);
        response.setHeader(
          "Set-Cookie",
          `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`,
        );
        log("info", "session.created");
        return json(response, { ok: true });
      }
      if (api && !authenticate(request))
        throw new HttpError(401, "AUTH_REQUIRED", "请从本机启动器打开工作台。");
      if (api) {
        const parts = pathname.split("/").filter(Boolean);
        const collection = parts[1];
        const id = parts[2];
        const action = parts[3];
        if (id && collection !== "settings") Id.parse(id);
        if (method === "GET" && pathname === "/api/snapshot")
          return json(response, await workspace.snapshot());
        if (method === "GET" && pathname === "/api/providers")
          return json(response, PROVIDERS);
        if (method === "POST" && pathname === "/api/employees")
          return json(
            response,
            await workspace.createEmployee(
              CreateEmployee.parse(await body(request)),
            ),
            201,
          );
        if (
          method === "PATCH" &&
          collection === "employees" &&
          id &&
          parts.length === 3
        )
          return json(
            response,
            await workspace.updateEmployee(
              id,
              UpdateEmployee.parse(await body(request)),
            ),
          );
        if (method === "POST" && pathname === "/api/conversations")
          return json(
            response,
            await workspace.createConversation(
              CreateConversation.parse(await body(request)),
            ),
            201,
          );
        if (
          method === "POST" &&
          collection === "conversations" &&
          id &&
          action === "messages" &&
          parts.length === 4
        )
          return json(
            response,
            await workspace.sendMessage(
              id,
              SendMessage.parse(await body(request)),
            ),
            201,
          );
        if (method === "POST" && pathname === "/api/tasks")
          return json(
            response,
            await workspace.createTask(CreateTask.parse(await body(request))),
            201,
          );
        if (
          method === "POST" &&
          collection === "tasks" &&
          id &&
          action === "action" &&
          parts.length === 4
        )
          return json(
            response,
            await workspace.taskAction(
              id,
              TaskAction.parse(await body(request)),
            ),
          );
        if (method === "POST" && pathname === "/api/settings/model")
          return json(
            response,
            await workspace.saveModel(SaveModel.parse(await body(request))),
          );
        if (method === "POST" && pathname === "/api/settings/execution")
          return json(
            response,
            await workspace.saveExecution(
              SaveExecution.parse(await body(request)),
            ),
          );
        if (method === "POST" && pathname === "/api/memories")
          return json(
            response,
            await workspace.createMemory(
              CreateMemory.parse(await body(request)),
            ),
            201,
          );
        if (
          method === "DELETE" &&
          collection === "memories" &&
          id &&
          parts.length === 3
        ) {
          await body(request);
          await workspace.deleteMemory(id);
          return json(response, { ok: true });
        }
        if (method === "POST" && pathname === "/api/rules")
          return json(
            response,
            await workspace.createRule(CreateRule.parse(await body(request))),
            201,
          );
        if (
          method === "PATCH" &&
          collection === "rules" &&
          id &&
          parts.length === 3
        )
          return json(
            response,
            await workspace.updateRule(
              id,
              z.object({ enabled: z.boolean() }).parse(await body(request)),
            ),
          );
        if (
          method === "POST" &&
          collection === "notices" &&
          id &&
          action === "read" &&
          parts.length === 4
        ) {
          await body(request);
          await workspace.readNotice(id);
          return json(response, { ok: true });
        }
        throw new HttpError(404, "NOT_FOUND", "接口不存在。");
      }
      if (method !== "GET" && method !== "HEAD")
        throw new HttpError(405, "METHOD", "不支持此请求方式。");
      // 静态资源仅允许构建目录，不跟随指向目录外的符号链接。
      const root = await realpath(distDir);
      const requested =
        pathname.startsWith("/assets/") ||
        pathname === "/favicon.svg" ||
        pathname === "/THIRD_PARTY_NOTICES.txt"
          ? resolve(root, "." + pathname)
          : resolve(root, "index.html");
      let file: string;
      try {
        file = await realpath(requested);
      } catch {
        throw new HttpError(
          404,
          "ASSET_NOT_FOUND",
          "资源不存在，请先构建工作台。",
        );
      }
      if (!file.startsWith(root + sep))
        throw new HttpError(403, "PATH_REJECTED", "无权读取此资源。");
      const bytes = await readFile(file);
      response.writeHead(200, {
        "Content-Type":
          contentTypes[extname(file)] || "application/octet-stream",
        "Cache-Control": "no-store",
      });
      response.end(method === "HEAD" ? undefined : bytes);
    } catch (error) {
      if (response.headersSent) {
        log("error", "http.after_headers");
        response.destroy();
        return;
      }
      if (error instanceof HttpError || error instanceof WorkspaceError)
        return json(
          response,
          { error: error.message, code: error.code },
          error.status,
        );
      if (error instanceof z.ZodError || error instanceof URIError)
        return json(
          response,
          { error: "参数格式不正确，请检查填写内容。", code: "VALIDATION" },
          400,
        );
      log("error", "http.unhandled");
      json(
        response,
        { error: "本机服务处理失败，请检查服务日志。", code: "INTERNAL" },
        500,
      );
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  return server;
}
