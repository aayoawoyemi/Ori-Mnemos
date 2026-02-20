import { runStatus } from "./status.js";
import {
  runQueryOrphans,
  runQueryDangling,
  runQueryBacklinks,
  runQueryCrossProject,
} from "./query.js";
import { runAdd } from "./add.js";
import { runValidate } from "./validate.js";
import { runHealth } from "./health.js";

const TOOL_LIST = [
  {
    name: "ori_status",
    description: "Vault overview",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "ori_query",
    description: "Query the vault (orphans, dangling, backlinks, cross-project)",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string" },
        note: { type: "string" },
      },
      required: ["kind"],
    },
  },
  {
    name: "ori_add",
    description: "Create a note in inbox",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        type: { type: "string" },
      },
      required: ["title"],
    },
  },
  {
    name: "ori_validate",
    description: "Validate a note against schema",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
      },
      required: ["path"],
    },
  },
  {
    name: "ori_health",
    description: "Full diagnostic",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
];

type JsonRpcRequest = {
  id?: string | number | null;
  method?: unknown;
  params?: Record<string, unknown>;
};

type JsonRpcError = {
  code: number;
  message: string;
  data?: unknown;
};

type JsonRpcResponse =
  | {
      jsonrpc: "2.0";
      id: JsonRpcRequest["id"];
      result: unknown;
    }
  | {
      jsonrpc: "2.0";
      id: JsonRpcRequest["id"];
      error: JsonRpcError;
    };

function encodeResponse(response: JsonRpcResponse): string {
  const body = JSON.stringify(response);
  return `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`;
}

function jsonRpcResult(id: JsonRpcRequest["id"], result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function jsonRpcError(
  id: JsonRpcRequest["id"],
  code: number,
  message: string,
  data?: unknown
): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message, data } };
}

async function handleToolsCall(params: Record<string, unknown> | undefined) {
  const name = params?.name;
  const input = (params?.arguments as Record<string, unknown>) ?? {};

  switch (name) {
    case "ori_status":
      return runStatus(process.cwd());
    case "ori_query":
      switch (input.kind) {
        case "orphans":
          return runQueryOrphans(process.cwd());
        case "dangling":
          return runQueryDangling(process.cwd());
        case "backlinks":
          if (typeof input.note !== "string") {
            return { success: false, data: {}, warnings: ["note required"] };
          }
          return runQueryBacklinks(process.cwd(), input.note);
        case "cross-project":
          return runQueryCrossProject(process.cwd());
        default:
          return { success: false, data: {}, warnings: ["unknown kind"] };
      }
    case "ori_add":
      if (typeof input.title !== "string") {
        return { success: false, data: {}, warnings: ["title required"] };
      }
      return runAdd({
        startDir: process.cwd(),
        title: input.title,
        type: typeof input.type === "string" ? input.type : "insight",
      });
    case "ori_validate":
      if (typeof input.path !== "string") {
        return { success: false, data: {}, warnings: ["path required"] };
      }
      return runValidate({ notePath: input.path });
    case "ori_health":
      return runHealth(process.cwd());
    default:
      return { success: false, data: {}, warnings: ["unknown tool"] };
  }
}

export async function handleJsonRpcRequest(
  request: JsonRpcRequest
): Promise<JsonRpcResponse | null> {
  if (typeof request.method !== "string") {
    return jsonRpcError(request.id ?? null, -32600, "Invalid Request: method must be a string");
  }

  if (request.method.startsWith("notifications/") || request.method === "initialized") {
    return null;
  }

  // Notifications must not receive responses.
  if (request.id === undefined) {
    return null;
  }

  if (request.method === "initialize") {
    return jsonRpcResult(request.id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "ori-memory", version: "0.1.0" },
    });
  }

  if (request.method === "tools/list") {
    return jsonRpcResult(request.id, { tools: TOOL_LIST });
  }

  if (request.method === "tools/call") {
    try {
      const result = await handleToolsCall(request.params);
      return jsonRpcResult(request.id, result);
    } catch (err: unknown) {
      return jsonRpcError(
        request.id,
        -32000,
        err instanceof Error ? err.message : "Internal server error"
      );
    }
  }

  return jsonRpcError(request.id, -32601, "Method not found");
}

export async function processMcpChunk(
  buffer: Buffer<ArrayBufferLike>,
  incoming: Buffer<ArrayBufferLike>
): Promise<{ buffer: Buffer<ArrayBufferLike>; responses: JsonRpcResponse[] }> {
  let nextBuffer = Buffer.concat([buffer, incoming]);
  const responses: JsonRpcResponse[] = [];

  while (true) {
    const headerEnd = nextBuffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) break;

    const headerBlock = nextBuffer.slice(0, headerEnd).toString("utf8");
    const headers = headerBlock.split("\r\n");
    const lengthHeader = headers.find((line) =>
      line.toLowerCase().startsWith("content-length:")
    );
    if (!lengthHeader) {
      nextBuffer = nextBuffer.slice(headerEnd + 4);
      responses.push(jsonRpcError(null, -32600, "Invalid Request: Missing Content-Length"));
      continue;
    }

    const lengthValue = lengthHeader.split(":").slice(1).join(":").trim();
    const bodyLength = Number(lengthValue);
    if (!Number.isFinite(bodyLength) || bodyLength <= 0) {
      nextBuffer = nextBuffer.slice(headerEnd + 4);
      responses.push(jsonRpcError(null, -32600, "Invalid Request: Invalid Content-Length"));
      continue;
    }

    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + bodyLength;
    if (nextBuffer.length < bodyEnd) break;

    const body = nextBuffer.slice(bodyStart, bodyEnd).toString("utf8");
    nextBuffer = nextBuffer.slice(bodyEnd);

    let rawRequest: unknown;
    try {
      rawRequest = JSON.parse(body);
    } catch {
      responses.push(jsonRpcError(null, -32700, "Parse error"));
      continue;
    }

    if (!rawRequest || typeof rawRequest !== "object") {
      responses.push(jsonRpcError(null, -32600, "Invalid Request"));
      continue;
    }

    const response = await handleJsonRpcRequest(rawRequest as JsonRpcRequest);
    if (response) {
      responses.push(response);
    }
  }

  return { buffer: nextBuffer, responses };
}

export async function runServeMcp(_startDir: string) {
  let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let processing = Promise.resolve();

  process.stdin.on("data", (chunk) => {
    const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
    processing = processing
      .then(async () => {
        const processed = await processMcpChunk(buffer, incoming);
        buffer = processed.buffer;
        for (const response of processed.responses) {
          process.stdout.write(encodeResponse(response));
        }
      })
      .catch((err: unknown) => {
        process.stdout.write(
          encodeResponse(
            jsonRpcError(
              null,
              -32000,
              err instanceof Error ? err.message : "Internal server error"
            )
          )
        );
      });
  });
}
