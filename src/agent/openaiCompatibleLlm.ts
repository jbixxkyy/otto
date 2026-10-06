import { BaseLlm } from "@google/adk";
import type { BaseLlmConnection, LlmRequest, LlmResponse } from "@google/adk";
import type { Content, FunctionDeclaration, FunctionResponse, Part, Schema } from "@google/genai";

interface OpenAIToolCall {
  id: string;
  type?: string;
  function: { name?: string; arguments?: string };
}

interface OpenAIMessage {
  role: string;
  content: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: OpenAIToolCall[];
}

interface CompletionChoice {
  message?: { content?: string | Array<{ type?: string; text?: string }>; tool_calls?: OpenAIToolCall[] };
  delta?: { content?: string; tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> };
  finish_reason?: string | null;
}

interface CompletionResponse {
  choices?: CompletionChoice[];
  error?: { message?: string; type?: string; code?: string };
}

function partText(part: Part): string {
  if (typeof part.text === "string") return part.text;
  if (part.functionCall) return "";
  if (part.functionResponse) return "";
  if (part.inlineData || part.fileData || part.executableCode || part.codeExecutionResult) {
    throw new Error("This OpenAI-compatible provider adapter supports text and tool calls, not multimodal input.");
  }
  return "";
}

function responseText(response: FunctionResponse): string {
  if (response.response !== undefined) return JSON.stringify(response.response);
  return JSON.stringify(response.parts ?? []);
}

function toOpenAIMessages(request: LlmRequest): OpenAIMessage[] {
  const messages: OpenAIMessage[] = [];
  const instruction = request.config?.systemInstruction;
  if (typeof instruction === "string" && instruction.trim()) {
    messages.push({ role: "system", content: instruction });
  } else if (instruction && typeof instruction === "object") {
    const systemText = "parts" in instruction && Array.isArray(instruction.parts)
      ? instruction.parts.map((part) => (part && typeof part === "object" && "text" in part ? String(part.text ?? "") : "")).join("\n")
      : "";
    if (systemText.trim()) messages.push({ role: "system", content: systemText });
  }

  for (const content of request.contents ?? []) {
    const role = content.role === "model" ? "assistant" : "user";
    const textParts: string[] = [];
    const toolCalls: OpenAIToolCall[] = [];
    const toolResponses: Array<{ id: string; name: string; content: string }> = [];

    for (const part of content.parts ?? []) {
      const text = partText(part);
      if (text) textParts.push(text);
      if (part.functionCall?.name) {
        const call = part.functionCall;
        toolCalls.push({
          id: call.id || `call_${toolCalls.length}`,
          type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
        });
      }
      if (part.functionResponse?.name) {
        const response = part.functionResponse;
        toolResponses.push({ id: response.id || "", name: response.name!, content: responseText(response) });
      }
    }

    if (toolResponses.length) {
      for (const response of toolResponses) {
        messages.push({ role: "tool", tool_call_id: response.id, name: response.name, content: response.content });
      }
      if (textParts.length) messages.push({ role, content: textParts.join("\n") });
      continue;
    }

    if (textParts.length || toolCalls.length || role === "user") {
      messages.push({ role, content: textParts.length ? textParts.join("\n") : null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) });
    }
  }
  return messages;
}

function schemaType(type?: string): string | undefined {
  if (!type) return undefined;
  const normalized = type.toLowerCase();
  return normalized === "type_unspecified" ? undefined : normalized;
}

function jsonSchema(schema: Schema | unknown): Record<string, unknown> {
  if (!schema || typeof schema !== "object") return { type: "object", properties: {} };
  const input = schema as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const type = schemaType(typeof input.type === "string" ? input.type : undefined);
  if (type) out.type = type;
  for (const key of ["description", "enum", "required", "format", "default", "minimum", "maximum", "minItems", "maxItems", "minLength", "maxLength", "additionalProperties"] as const) {
    if (input[key] !== undefined) out[key] = input[key];
  }
  if (input.properties && typeof input.properties === "object" && !Array.isArray(input.properties)) {
    out.properties = Object.fromEntries(Object.entries(input.properties as Record<string, unknown>).map(([key, value]) => [key, jsonSchema(value)]));
  }
  if (input.items !== undefined) out.items = jsonSchema(input.items);
  if (Array.isArray(input.anyOf)) out.anyOf = input.anyOf.map(jsonSchema);
  if (Array.isArray(input.oneOf)) out.oneOf = input.oneOf.map(jsonSchema);
  return out;
}

function functionDeclaration(declaration: FunctionDeclaration): Record<string, unknown> | null {
  if (!declaration.name) return null;
  const parameters = declaration.parametersJsonSchema ?? (declaration.parameters ? jsonSchema(declaration.parameters) : { type: "object", properties: {} });
  return {
    type: "function",
    function: { name: declaration.name, description: declaration.description ?? "", parameters },
  };
}

function requestBody(request: LlmRequest, model: string, stream: boolean): Record<string, unknown> {
  const config = request.config ?? {};
  const body: Record<string, unknown> = {
    model,
    messages: toOpenAIMessages(request),
    stream,
  };
  if (typeof config.temperature === "number") body.temperature = config.temperature;
  if (typeof config.topP === "number") body.top_p = config.topP;
  if (typeof config.maxOutputTokens === "number") body.max_tokens = config.maxOutputTokens;
  if (Array.isArray(config.stopSequences)) body.stop = config.stopSequences;
  if (typeof config.presencePenalty === "number") body.presence_penalty = config.presencePenalty;
  if (typeof config.frequencyPenalty === "number") body.frequency_penalty = config.frequencyPenalty;
  if (typeof config.seed === "number") body.seed = config.seed;
  const declarations = (config.tools ?? []).flatMap((tool) => {
    if (!tool || typeof tool !== "object" || !("functionDeclarations" in tool) || !Array.isArray(tool.functionDeclarations)) return [];
    return tool.functionDeclarations.map((item) => functionDeclaration(item as FunctionDeclaration)).filter((item): item is Record<string, unknown> => item !== null);
  });
  if (declarations.length) {
    body.tools = declarations;
    const allowed = request.allowedTools?.filter((name) => declarations.some((tool) => (tool.function as { name?: string }).name === name));
    if (allowed?.length) {
      body.tool_choice = { type: "function", function: { name: allowed[0] } };
    }
  }
  if (config.responseMimeType === "application/json") body.response_format = { type: "json_object" };
  return body;
}

function parseToolCalls(toolCalls: OpenAIToolCall[] | undefined): Part[] {
  return (toolCalls ?? []).flatMap((call) => {
    if (!call.function?.name) return [];
    let args: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(call.function.arguments || "{}");
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) args = parsed as Record<string, unknown>;
    } catch {
      throw new Error(`Provider returned invalid JSON arguments for tool ${call.function.name}.`);
    }
    return [{ functionCall: { id: call.id, name: call.function.name, args } }];
  });
}

function responseContent(choice: CompletionChoice | undefined): Content | undefined {
  const message = choice?.message;
  if (!message) return undefined;
  const parts: Part[] = [];
  if (typeof message.content === "string" && message.content) parts.push({ text: message.content });
  else if (Array.isArray(message.content)) {
    const text = message.content.flatMap((part) => typeof part.text === "string" ? [part.text] : []).join("");
    if (text) parts.push({ text });
  }
  parts.push(...parseToolCalls(message.tool_calls));
  return parts.length ? { role: "model", parts } : undefined;
}

function safeErrorText(text: string): string {
  return text.replace(/\bsk-[A-Za-z0-9_-]{12,}/g, "[redacted]").replace(/AIza[0-9A-Za-z_-]{10,}/g, "[redacted]");
}

export class OpenAICompatibleLlm extends BaseLlm {
  static override readonly supportedModels: Array<string | RegExp> = [];

  constructor(
    params: { model: string; baseUrl: string; apiKey: string },
  ) {
    super({ model: params.model });
    this.baseUrl = params.baseUrl.replace(/\/+$/, "");
    this.apiKey = params.apiKey;
  }

  private readonly baseUrl: string;
  private readonly apiKey: string;

  override async *generateContentAsync(llmRequest: LlmRequest, stream = false, abortSignal?: AbortSignal): AsyncGenerator<LlmResponse, void> {
    const url = `${this.baseUrl}/chat/completions`;
    const headers: Record<string, string> = { "Content-Type": "application/json", Accept: stream ? "text/event-stream" : "application/json" };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(requestBody(llmRequest, this.model, stream)),
        signal: abortSignal,
      });
    } catch (error) {
      if (abortSignal?.aborted) return;
      throw new Error(safeErrorText(error instanceof Error ? error.message : String(error)));
    }
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      let detail = body;
      try {
        const parsed = JSON.parse(body) as CompletionResponse;
        detail = parsed.error?.message || body;
      } catch {
        // Keep plain-text endpoint errors useful.
      }
      throw new Error(`OpenAI-compatible provider returned HTTP ${response.status}: ${safeErrorText(detail).slice(0, 1000)}`);
    }

    if (!stream || !response.body) {
      const payload = await response.json() as CompletionResponse;
      const content = responseContent(payload.choices?.[0]);
      if (!content) throw new Error("OpenAI-compatible provider returned an empty completion.");
      yield { content, turnComplete: true };
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let text = "";
    const toolCalls = new Map<number, OpenAIToolCall>();
    let finishReason: string | null = null;
    const consume = (line: string): LlmResponse[] => {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) return [];
      const data = trimmed.slice(5).trim();
      if (!data || data === "[DONE]") return [];
      let payload: { choices?: CompletionChoice[] };
      try {
        payload = JSON.parse(data) as { choices?: CompletionChoice[] };
      } catch {
        throw new Error("OpenAI-compatible provider returned malformed streaming JSON.");
      }
      const delta = payload.choices?.[0]?.delta;
      finishReason = payload.choices?.[0]?.finish_reason ?? finishReason;
      const responses: LlmResponse[] = [];
      if (delta?.content) {
        text += delta.content;
        responses.push({ content: { role: "model", parts: [{ text: delta.content }] }, partial: true });
      }
      for (const incoming of delta?.tool_calls ?? []) {
        const index = incoming.index ?? 0;
        const current = toolCalls.get(index) ?? { id: "", type: "function", function: { name: "", arguments: "" } };
        if (incoming.id) current.id += incoming.id;
        if (incoming.function?.name) current.function.name = (current.function.name ?? "") + incoming.function.name;
        if (incoming.function?.arguments) current.function.arguments = (current.function.arguments ?? "") + incoming.function.arguments;
        toolCalls.set(index, current);
      }
      return responses;
    };

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          for (const result of consume(line)) yield result;
          newline = buffer.indexOf("\n");
        }
      }
      buffer += decoder.decode();
      if (buffer.trim()) for (const result of consume(buffer)) yield result;
    } finally {
      reader.releaseLock();
    }

    const parts: Part[] = [];
    if (text) parts.push({ text });
    parts.push(...parseToolCalls([...toolCalls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call)));
    if (!parts.length) throw new Error("OpenAI-compatible provider returned an empty completion.");
    yield { content: { role: "model", parts }, turnComplete: true, finishReason: (finishReason || undefined) as LlmResponse["finishReason"] };
  }

  override async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error("Live audio/video sessions are not supported by OpenAI-compatible providers.");
  }
}
