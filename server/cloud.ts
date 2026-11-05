import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, realpath } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { z } from "zod";
import {
  PairInputSchema, SubmitSchema, SyncInputSchema,
  MAX_PUBLICATION_BYTES, loopbackOrigin,
} from "../shared/relay.ts";
import { CloudError, CloudStore } from "./cloud-store.ts";
import { log } from "./log.ts";

export { CloudStore, CloudError } from "./cloud-store.ts";
type Options = { store: CloudStore; origin: string; distDir: string };
const Empty = z.object({}).strict();
const Login = z.object({ password: z.string().min(16).max(256) }).strict();
const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png",
  ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8",
};
function sessionToken(request: IncomingMessage): string {
  const values = (request.headers.cookie ?? "").split(";").map((value) => value.trim())
    .filter((value) => value.startsWith("jarvis_cloud_session="));
  return values.length === 1 ? values[0].slice("jarvis_cloud_session=".length) : "";
}
function requireJson(request: IncomingMessage): void {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers["content-type"] ?? ""))
    throw new CloudError(415, "CONTENT_TYPE", "请求必须使用 JSON。");
}
async function readBody(request: IncomingMessage, maxBytes = 256 * 1024): Promise<unknown> {
  requireJson(request);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > maxBytes) {
      request.resume();
      throw new CloudError(413, "BODY_TOO_LARGE", "请求内容过大。");
    }
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new CloudError(400, "INVALID_JSON", "JSON 格式错误。");
  }
}
function json(response: ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(value));
}

export function createCloudServer(options: Options) {
  const { store, distDir } = options;
  const origin = loopbackOrigin(options.origin);
  const host = new URL(origin).host;
  const server = createServer(async (request, response) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    try {
      if (request.headers.host !== host)
        throw new CloudError(403, "HOST_REJECTED", "仅允许本机工作台地址。");
      const method = request.method ?? "GET";
      if (!(request.url ?? "/").startsWith("/") || request.url?.startsWith("//"))
        throw new CloudError(400, "INVALID_URL", "请求地址格式不正确。");
      const url = new URL(request.url ?? "/", origin);
      const pathname = decodeURIComponent(url.pathname);
      const browserApi = pathname.startsWith("/api/");
      const workerApi = pathname.startsWith("/worker/");
      if ((browserApi || workerApi) && url.search)
        throw new CloudError(400, "INVALID_URL", "接口不接受查询参数。");
      if (browserApi) {
        if (request.headers.authorization !== undefined)
          throw new CloudError(403, "AUTH_SCOPE", "浏览器接口不接受设备凭据。");
        if (method !== "GET" && method !== "HEAD") {
          if (request.headers.origin !== origin || request.headers["x-jarvis-request"] !== "1")
            throw new CloudError(403, "ORIGIN_REJECTED", "请求来源校验失败。");
          requireJson(request);
        }
        if (method === "GET" && pathname === "/api/mode") return json(response, { mode: "cloud" });
        if (method === "GET" && pathname === "/api/health") return json(response, { ok: true });
        if (method === "POST" && pathname === "/api/session") {
          const input = Login.parse(await readBody(request));
          const { token, csrf } = await store.login(input.password);
          response.setHeader("Set-Cookie", `jarvis_cloud_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`);
          return json(response, { csrf });
        }
        const token = sessionToken(request);
        const session = store.session(token);
        if (!session) throw new CloudError(401, "AUTH_REQUIRED", "请先登录云端工作台。");
        if (method !== "GET" && method !== "HEAD" &&
            !store.verifyCsrf(token, String(request.headers["x-jarvis-csrf"] ?? "")))
          throw new CloudError(403, "CSRF_REJECTED", "请求凭据校验失败，请刷新工作台。");
        if (method === "GET" && pathname === "/api/session") return json(response, session);
        if (method === "POST" && pathname === "/api/logout") {
          Empty.parse(await readBody(request));
          store.logout(token);
          response.setHeader("Set-Cookie", "jarvis_cloud_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
          return json(response, { ok: true });
        }
        if (method === "GET" && pathname === "/api/cloud/view") return json(response, store.view());
        if (method === "POST" && pathname === "/api/cloud/commands")
          return json(response, store.submit(SubmitSchema.parse(await readBody(request))), 202);
        if (method === "POST" && pathname === "/api/cloud/pair") {
          Empty.parse(await readBody(request));
          return json(response, store.pairCode());
        }
        if (method === "POST" && pathname === "/api/cloud/revoke") {
          Empty.parse(await readBody(request));
          store.revoke();
          return json(response, { ok: true });
        }
        throw new CloudError(404, "NOT_FOUND", "接口不存在。");
      }
      if (workerApi) {
        if (request.headers.cookie !== undefined)
          throw new CloudError(403, "AUTH_SCOPE", "设备接口不接受浏览器会话。");
        if (method !== "POST") throw new CloudError(405, "METHOD", "设备接口只接受 POST。");
        if (pathname === "/worker/pair") {
          if (request.headers.authorization !== undefined)
            throw new CloudError(403, "AUTH_SCOPE", "首次配对只接受配对码。");
          return json(response, store.pair(PairInputSchema.parse(await readBody(request))));
        }
        if (pathname === "/worker/sync") {
          const match = /^Bearer ([a-f0-9]{64})$/.exec(request.headers.authorization ?? "");
          if (!match) throw new CloudError(401, "DEVICE_REJECTED", "设备凭据已失效，请在 Mac 重新配对。");
          const input = SyncInputSchema.parse(await readBody(request, MAX_PUBLICATION_BYTES + 64 * 1024));
          return json(response, store.sync(match[1], input));
        }
        throw new CloudError(404, "NOT_FOUND", "接口不存在。");
      }
      if (method !== "GET" && method !== "HEAD")
        throw new CloudError(405, "METHOD", "不支持此请求方式。");
      const root = await realpath(distDir);
      const requested = pathname.startsWith("/assets/") || pathname === "/favicon.svg" || pathname === "/THIRD_PARTY_NOTICES.txt"
        ? resolve(root, "." + pathname) : resolve(root, "index.html");
      let file: string;
      try {
        file = await realpath(requested);
      } catch {
        throw new CloudError(404, "ASSET_NOT_FOUND", "资源不存在，请先构建工作台。");
      }
      if (!file.startsWith(root + sep))
        throw new CloudError(403, "PATH_REJECTED", "无权读取此资源。");
      const bytes = await readFile(file);
      response.writeHead(200, { "Content-Type": contentTypes[extname(file)] ?? "application/octet-stream", "Cache-Control": "no-store" });
      response.end(method === "HEAD" ? undefined : bytes);
    } catch (error) {
      if (response.headersSent) {
        log("error", "cloud.http_after_headers");
        response.destroy();
        return;
      }
      if (error instanceof CloudError)
        return json(response, { error: error.message, code: error.code }, error.status);
      if (error instanceof z.ZodError || error instanceof URIError)
        return json(response, { error: "参数格式不正确，请检查填写内容。", code: "VALIDATION" }, 400);
      log("error", "cloud.http_unhandled");
      json(response, { error: "云端服务处理失败，请检查服务日志。", code: "INTERNAL" }, 500);
    }
  });
  // 必须在 listen 之前拒绝公网绑定，不能先监听再补救关闭。
  server.listen = new Proxy(server.listen, {
    apply(target, receiver, args) {
      if (typeof args[0] === "number") {
        if (args[1] === undefined || typeof args[1] === "function") args.splice(1, 0, "127.0.0.1");
        else if (args[1] !== "127.0.0.1") throw new Error("Cloud 只允许绑定 127.0.0.1。");
      } else if (args[0] !== null && typeof args[0] === "object" && "port" in args[0]) {
        const options = z.object({ port: z.number().int().min(0).max(65535), host: z.literal("127.0.0.1").optional() }).strict().safeParse(args[0]);
        if (!options.success) throw new Error("Cloud 只允许绑定 127.0.0.1，且不接受已有 socket。");
        args[0] = { ...options.data, host: "127.0.0.1" };
      } else throw new Error("Cloud 只允许 TCP loopback 监听。");
      return Reflect.apply(target, receiver, args);
    },
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  return server;
}
