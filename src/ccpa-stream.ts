import crypto from "node:crypto";
import {
	calculateCost,
	collapseSystemMessages,
	createAssistantMessageEventStream,
	getCurrentSystemPrompt,
	getCurrentTools,
	normalizeContext,
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	type ImageContent,
	type Model,
	type SimpleStreamOptions,
	type StopReason,
	type TextContent,
	type ThinkingContent,
	type Tool,
	type ToolCall,
	type ToolResultMessage,
} from "@earendil-works/pi-ai";
import {
	CCPA_BASE_URLS,
	ccpaHeaders,
	combineSignals,
	ensureAccountAuth,
	type AntigravityProviderId,
} from "./ccpa-auth.js";
import { normalizeBaseModelId, resolveRemoteModelId } from "./ccpa-models.js";

const CONNECT_TIMEOUT_MS = 45_000;
const CHUNK_IDLE_TIMEOUT_MS = 120_000;
const SKIP_THOUGHT_SIGNATURE = "skip_thought_signature_validator";
const BASE64_SIG_RE = /^[A-Za-z0-9+/]+={0,2}$/;

function isValidThoughtSignature(sig: string | undefined): sig is string {
	return typeof sig === "string" && sig.length > 0 && sig.length % 4 === 0 && BASE64_SIG_RE.test(sig);
}

/** Remove lone UTF-16 surrogates so JSON payloads stay valid UTF-8. */
function sanitizeSurrogates(text: string): string {
	let out = "";
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if (code >= 0xd800 && code <= 0xdbff) {
			const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
			if (next >= 0xdc00 && next <= 0xdfff) {
				out += text[i] + text[i + 1];
				i++;
			}
			continue;
		}
		if (code >= 0xdc00 && code <= 0xdfff) {
			continue;
		}
		out += text[i];
	}
	return out;
}

function rewriteSchemaForGemini(node: unknown): unknown {
	if (Array.isArray(node)) {
		return node.map(rewriteSchemaForGemini);
	}
	if (!node || typeof node !== "object") {
		return node;
	}
	const src = node as Record<string, unknown>;
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(src)) {
		if (k === "$schema") continue;
		out[k] = rewriteSchemaForGemini(v);
	}
	if ("const" in out) {
		const val = out.const;
		delete out.const;
		if (!Array.isArray(out.enum)) {
			out.enum = [val];
		}
		if (out.type === undefined) {
			if (typeof val === "string") out.type = "string";
			else if (typeof val === "number") out.type = Number.isInteger(val) ? "integer" : "number";
			else if (typeof val === "boolean") out.type = "boolean";
		}
	}
	return out;
}

function convertTools(tools: readonly Tool[] | undefined) {
	if (!tools || tools.length === 0) return undefined;
	return [
		{
			functionDeclarations: tools.map((tool) => ({
				name: tool.name,
				description: tool.description || tool.name,
				parametersJsonSchema: rewriteSchemaForGemini(tool.parameters ?? { type: "object", properties: {} }),
			})),
		},
	];
}

interface GeminiPart {
	text?: string;
	thought?: boolean;
	thoughtSignature?: string;
	inlineData?: { mimeType: string; data: string };
	functionCall?: { id?: string; name: string; args?: Record<string, unknown> };
	functionResponse?: { id?: string; name: string; response: Record<string, unknown> };
}

interface GeminiContent {
	role: "user" | "model";
	parts: GeminiPart[];
}

function prepareMessages(messages: Context["messages"], model: Model<Api>) {
	const supportsImages = model.input.includes("image");
	const normalized = messages
		.filter((m) => m.role !== "system")
		.map((m) => {
			if ((m.role === "user" && Array.isArray(m.content)) || m.role === "toolResult") {
				const content = (m.content ?? []).map((b) =>
					b.type === "image" && !supportsImages
						? { type: "text" as const, text: "(image omitted: model does not support images)" }
						: b,
				);
				return { ...m, content };
			}
			return m;
		});

	const out: typeof normalized = [];
	let pendingCalls: ToolCall[] = [];
	let seenResultIds = new Set<string>();

	const flushOrphans = () => {
		if (pendingCalls.length === 0) return;
		for (const tc of pendingCalls) {
			if (!seenResultIds.has(tc.id)) {
				const synthetic: ToolResultMessage = {
					role: "toolResult",
					toolCallId: tc.id,
					toolName: tc.name,
					content: [{ type: "text", text: "No result provided" }],
					isError: true,
					timestamp: Date.now(),
				};
				out.push(synthetic);
			}
		}
		pendingCalls = [];
		seenResultIds = new Set();
	};

	for (const msg of normalized) {
		if (msg.role === "assistant") {
			flushOrphans();
			if (msg.stopReason === "error" || msg.stopReason === "aborted") {
				continue;
			}
			const calls = (msg.content ?? []).filter((b): b is ToolCall => b.type === "toolCall");
			if (calls.length > 0) {
				pendingCalls = calls;
				seenResultIds = new Set();
			}
			out.push(msg);
		} else if (msg.role === "toolResult") {
			seenResultIds.add(msg.toolCallId);
			out.push(msg);
		} else {
			flushOrphans();
			out.push(msg);
		}
	}
	flushOrphans();
	return out;
}

function pushContent(contents: GeminiContent[], role: "user" | "model", parts: GeminiPart[]) {
	if (parts.length === 0) return;
	const prev = contents[contents.length - 1];
	if (prev && prev.role === role) {
		prev.parts.push(...parts);
	} else {
		contents.push({ role, parts: [...parts] });
	}
}

function convertContents(messages: Context["messages"], model: Model<Api>): GeminiContent[] {
	const prepared = prepareMessages(messages, model);
	const contents: GeminiContent[] = [];
	const targetBase = normalizeBaseModelId(model.id);

	for (const msg of prepared) {
		if (msg.role === "user") {
			const parts: GeminiPart[] = [];
			if (typeof msg.content === "string") {
				if (msg.content.length > 0) parts.push({ text: sanitizeSurrogates(msg.content) });
			} else if (Array.isArray(msg.content)) {
				for (const block of msg.content) {
					if (block.type === "text") {
						if (block.text.length > 0) parts.push({ text: sanitizeSurrogates(block.text) });
					} else if (block.type === "image") {
						parts.push({ inlineData: { mimeType: block.mimeType, data: block.data } });
					}
				}
			}
			if (parts.length === 0) parts.push({ text: "" });
			pushContent(contents, "user", parts);
			continue;
		}

		if (msg.role === "assistant") {
			const sameGeminiModel =
				msg.api === model.api && normalizeBaseModelId(msg.model) === targetBase;
			const parts: GeminiPart[] = [];
			for (const block of msg.content ?? []) {
				if (block.type === "thinking") {
					const tc = block as ThinkingContent;
					if (!sameGeminiModel) continue;
					if (!tc.thinking || !tc.thinking.trim()) continue;
					const part: GeminiPart = { thought: true, text: sanitizeSurrogates(tc.thinking) };
					if (isValidThoughtSignature(tc.thinkingSignature)) {
						part.thoughtSignature = tc.thinkingSignature;
					}
					parts.push(part);
				} else if (block.type === "text") {
					const txt = block as TextContent;
					if (!txt.text) continue;
					const part: GeminiPart = { text: sanitizeSurrogates(txt.text) };
					if (sameGeminiModel && isValidThoughtSignature(txt.textSignature)) {
						part.thoughtSignature = txt.textSignature;
					}
					parts.push(part);
				} else if (block.type === "toolCall") {
					const tc = block as ToolCall;
					const sig =
						sameGeminiModel && isValidThoughtSignature(tc.thoughtSignature)
							? tc.thoughtSignature
							: SKIP_THOUGHT_SIGNATURE;
					parts.push({
						thoughtSignature: sig,
						functionCall: {
							...(tc.id ? { id: tc.id } : {}),
							name: tc.name,
							args: tc.arguments ?? {},
						},
					});
				}
			}
			pushContent(contents, "model", parts);
			continue;
		}

		if (msg.role === "toolResult") {
			const tr = msg as ToolResultMessage;
			const texts = (tr.content ?? [])
				.filter((b): b is TextContent => b.type === "text")
				.map((b) => sanitizeSurrogates(b.text));
			const images = (tr.content ?? []).filter((b): b is ImageContent => b.type === "image");
			let resultText = texts.join("\n");
			if (!resultText) {
				resultText = images.length > 0 ? "(see attached image)" : "(empty tool result)";
			}

			const parts: GeminiPart[] = [
				{
					functionResponse: {
						...(tr.toolCallId ? { id: tr.toolCallId } : {}),
						name: tr.toolName,
						response: tr.isError ? { error: resultText } : { output: resultText },
					},
				},
			];
			for (const img of images) {
				parts.push({ inlineData: { mimeType: img.mimeType, data: img.data } });
			}
			pushContent(contents, "user", parts);
		}
	}

	return contents;
}

function mapFinishReason(rawReason: string | undefined, hasToolCalls: boolean): {
	stopReason: StopReason;
	errorDetail?: string;
} {
	if (hasToolCalls) {
		return { stopReason: "toolUse" };
	}
	switch (rawReason) {
		case undefined:
		case "STOP":
			return { stopReason: "stop" };
		case "MAX_TOKENS":
			return { stopReason: "length" };
		default:
			return { stopReason: "error", errorDetail: `Gemini finished with reason: ${rawReason}` };
	}
}

interface RawSseChunk {
	response?: {
		candidates?: Array<{
			content?: { parts?: GeminiPart[] };
			finishReason?: string;
		}>;
		usageMetadata?: {
			promptTokenCount?: number;
			cachedContentTokenCount?: number;
			candidatesTokenCount?: number;
			thoughtsTokenCount?: number;
			totalTokenCount?: number;
		};
		responseId?: string;
		modelVersion?: string;
	};
	candidates?: Array<{
		content?: { parts?: GeminiPart[] };
		finishReason?: string;
	}>;
	usageMetadata?: {
		promptTokenCount?: number;
		cachedContentTokenCount?: number;
		candidatesTokenCount?: number;
		thoughtsTokenCount?: number;
		totalTokenCount?: number;
	};
}

function isRetryableStatus(status: number): boolean {
	return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function parseRetryDelayMs(headers: Headers, attempt: number, maxRetryDelayMs?: number): number {
	const ra = headers.get("retry-after");
	let delayMs = Math.min(1000 * 2 ** attempt, 8000);
	if (ra) {
		const secs = Number(ra);
		if (Number.isFinite(secs) && secs >= 0) {
			delayMs = Math.round(secs * 1000);
		}
	}
	const ceiling = typeof maxRetryDelayMs === "number" && maxRetryDelayMs > 0 ? maxRetryDelayMs : 15_000;
	return Math.min(delayMs, ceiling);
}

async function openCcpaStreamResponse(
	providerId: AntigravityProviderId,
	requestPayload: Record<string, unknown>,
	options?: SimpleStreamOptions,
): Promise<Response> {
	let auth = await ensureAccountAuth(providerId, {
		apiKeyOverride: options?.apiKey,
		signal: options?.signal,
	});

	let refetchedOn401 = false;
	let lastStatus = 0;
	let lastErrorText = "";

	for (let baseIdx = 0; baseIdx < CCPA_BASE_URLS.length; baseIdx++) {
		const url = `${CCPA_BASE_URLS[baseIdx]}/v1internal:streamGenerateContent?alt=sse`;
		const bodyJson = JSON.stringify({
			...requestPayload,
			project: auth.projectId,
		});

		for (let attempt = 0; attempt < 3; attempt++) {
			options?.signal?.throwIfAborted();
			const reqSignal = combineSignals([options?.signal, AbortSignal.timeout(CONNECT_TIMEOUT_MS)]);
			try {
				const res = await fetch(url, {
					method: "POST",
					headers: {
						...ccpaHeaders(auth.accessToken),
						...(options?.headers ?? {}),
					},
					body: bodyJson,
					signal: reqSignal,
				});

				if (res.ok && res.body) {
					return res;
				}

				lastStatus = res.status;
				lastErrorText = await res.text().catch(() => "");

				if (res.status === 401 && !refetchedOn401) {
					refetchedOn401 = true;
					auth = await ensureAccountAuth(providerId, {
						forceRefresh: true,
						signal: options?.signal,
					});
					continue;
				}

				if (isRetryableStatus(res.status) && attempt < 2) {
					const waitMs = parseRetryDelayMs(res.headers, attempt, options?.maxRetryDelayMs);
					await new Promise<void>((resolve, reject) => {
						const t = setTimeout(resolve, waitMs);
						options?.signal?.addEventListener(
							"abort",
							() => {
								clearTimeout(t);
								reject(new Error("Aborted"));
							},
							{ once: true },
						);
					});
					continue;
				}

				if (res.status >= 400 && res.status < 500 && res.status !== 404 && res.status !== 429) {
					throw new Error(`CCPA error ${res.status}: ${lastErrorText.slice(0, 400)}`);
				}
				break;
			} catch (err) {
				if (options?.signal?.aborted) throw err;
				lastErrorText = err instanceof Error ? err.message : String(err);
				if (attempt < 2) {
					await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
					continue;
				}
			}
		}
	}

	throw new Error(`CCPA request failed (${lastStatus || "network"}): ${lastErrorText.slice(0, 400)}`);
}

async function readChunkWithIdleTimeout(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	signal?: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
	signal?.throwIfAborted();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeoutPromise = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			reject(new Error(`CCPA stream stalled (no chunk for ${CHUNK_IDLE_TIMEOUT_MS / 1000}s)`));
		}, CHUNK_IDLE_TIMEOUT_MS);
	});
	let onAbort: (() => void) | undefined;
	const abortPromise = signal
		? new Promise<never>((_, reject) => {
				onAbort = () => reject(new Error("Request aborted"));
				signal.addEventListener("abort", onAbort, { once: true });
			})
		: undefined;

	try {
		const races: Array<Promise<ReadableStreamReadResult<Uint8Array>>> = [reader.read(), timeoutPromise];
		if (abortPromise) races.push(abortPromise);
		return await Promise.race(races);
	} finally {
		if (timer) clearTimeout(timer);
		if (signal && onAbort) signal.removeEventListener("abort", onAbort);
	}
}

export function streamCcpaGemini(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();

	(async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};

		let currentBlock: TextContent | ThinkingContent | null = null;
		const closeCurrentBlock = () => {
			if (!currentBlock) return;
			const idx = output.content.length - 1;
			if (currentBlock.type === "text") {
				stream.push({ type: "text_end", contentIndex: idx, content: currentBlock.text, partial: output });
			} else {
				stream.push({ type: "thinking_end", contentIndex: idx, content: currentBlock.thinking, partial: output });
			}
			currentBlock = null;
		};

		try {
			const providerId: AntigravityProviderId =
				model.provider === "antigravity-cli" ? "antigravity-cli" : "antigravity";

			const resolvedTranscript = collapseSystemMessages(normalizeContext(context));
			const systemText = sanitizeSurrogates(
				getCurrentSystemPrompt(resolvedTranscript.messages) || context.systemPrompt || "",
			);
			const activeTools = context.tools ?? getCurrentTools(resolvedTranscript.messages);
			const contents = convertContents(resolvedTranscript.messages, model);
			const remoteModel = resolveRemoteModelId(model.id, options?.reasoning);

			const generationConfig: Record<string, unknown> = {
				thinkingConfig: { includeThoughts: true },
			};
			if (options?.maxTokens ?? model.maxTokens) {
				generationConfig.maxOutputTokens = options?.maxTokens ?? model.maxTokens;
			}
			if (options?.temperature !== undefined) {
				generationConfig.temperature = options.temperature;
			}

			const toolsPayload = convertTools(activeTools);
			const requestObj: Record<string, unknown> = {
				contents,
				generationConfig,
				...(systemText ? { systemInstruction: { parts: [{ text: systemText }] } } : {}),
				...(toolsPayload
					? {
							tools: toolsPayload,
							toolConfig: { functionCallingConfig: { mode: "AUTO" } },
						}
					: {}),
			};

			await options?.onPayload?.({ model: remoteModel, request: requestObj }, model);

			const response = await openCcpaStreamResponse(
				providerId,
				{
					model: remoteModel,
					request: requestObj,
				},
				options,
			);

			stream.push({ type: "start", partial: output });

			const reader = response.body!.getReader();
			const decoder = new TextDecoder("utf-8");
			let buffer = "";
			let lastRawFinishReason: string | undefined;
			let toolCallSeq = 0;

			const processEventData = (rawJson: string) => {
				if (!rawJson || rawJson === "[DONE]") return;
				let parsed: RawSseChunk;
				try {
					parsed = JSON.parse(rawJson) as RawSseChunk;
				} catch {
					return;
				}
				const payload = parsed.response ?? parsed;
				const candidate = payload.candidates?.[0];
				if (candidate?.finishReason) {
					lastRawFinishReason = candidate.finishReason;
				}

				for (const part of candidate?.content?.parts ?? []) {
					if (part.text !== undefined) {
						if (part.thought === true) {
							if (part.text.length === 0 && !part.thoughtSignature) continue;
							if (!currentBlock || currentBlock.type !== "thinking") {
								closeCurrentBlock();
								currentBlock = { type: "thinking", thinking: "" };
								output.content.push(currentBlock);
								stream.push({ type: "thinking_start", contentIndex: output.content.length - 1, partial: output });
							}
							if (part.text.length > 0) {
								currentBlock.thinking += part.text;
								stream.push({
									type: "thinking_delta",
									contentIndex: output.content.length - 1,
									delta: part.text,
									partial: output,
								});
							}
							if (isValidThoughtSignature(part.thoughtSignature)) {
								currentBlock.thinkingSignature = part.thoughtSignature;
							}
						} else {
							if (part.text.length === 0 && !currentBlock && !part.thoughtSignature) {
								continue;
							}
							if (!currentBlock || currentBlock.type !== "text") {
								if (part.text.length === 0) continue;
								closeCurrentBlock();
								currentBlock = { type: "text", text: "" };
								output.content.push(currentBlock);
								stream.push({ type: "text_start", contentIndex: output.content.length - 1, partial: output });
							}
							if (part.text.length > 0) {
								currentBlock.text += part.text;
								stream.push({
									type: "text_delta",
									contentIndex: output.content.length - 1,
									delta: part.text,
									partial: output,
								});
							}
							if (isValidThoughtSignature(part.thoughtSignature)) {
								currentBlock.textSignature = part.thoughtSignature;
							}
						}
					}

					if (part.functionCall) {
						closeCurrentBlock();
						const fc = part.functionCall;
						const id = fc.id || `call_${++toolCallSeq}_${crypto.randomUUID().slice(0, 8)}`;
						const args = (fc.args && typeof fc.args === "object" ? fc.args : {}) as Record<string, unknown>;
						const tc: ToolCall = {
							type: "toolCall",
							id,
							name: fc.name,
							arguments: args,
							...(isValidThoughtSignature(part.thoughtSignature) ? { thoughtSignature: part.thoughtSignature } : {}),
						};
						output.content.push(tc);
						const idx = output.content.length - 1;
						stream.push({ type: "toolcall_start", contentIndex: idx, partial: output });
						stream.push({ type: "toolcall_delta", contentIndex: idx, delta: JSON.stringify(args), partial: output });
						stream.push({ type: "toolcall_end", contentIndex: idx, toolCall: tc, partial: output });
					}
				}

				if (payload.usageMetadata) {
					const u = payload.usageMetadata;
					const promptTokens = u.promptTokenCount ?? 0;
					const cacheRead = u.cachedContentTokenCount ?? 0;
					const input = Math.max(0, promptTokens - cacheRead);
					const outTokens = (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0);
					const totalTokens = u.totalTokenCount ?? input + cacheRead + outTokens;
					output.usage = {
						input,
						output: outTokens,
						cacheRead,
						cacheWrite: 0,
						totalTokens,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					};
					calculateCost(model, output.usage);
				}
			};

			try {
				while (true) {
					const { done, value } = await readChunkWithIdleTimeout(reader, options?.signal);
					if (done) break;
					buffer += decoder.decode(value, { stream: true });
					const lines = buffer.split("\n");
					buffer = lines.pop() ?? "";
					for (const rawLine of lines) {
						const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
						if (line.startsWith("data:")) {
							processEventData(line.slice(5).trim());
						}
					}
				}
				buffer += decoder.decode();
				if (buffer.trim()) {
					for (const rawLine of buffer.split("\n")) {
						const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
						if (line.startsWith("data:")) {
							processEventData(line.slice(5).trim());
						}
					}
				}
			} finally {
				await reader.cancel().catch(() => {});
			}

			closeCurrentBlock();

			if (options?.signal?.aborted) {
				throw new Error("Request was aborted");
			}

			const hasToolCalls = output.content.some((b) => b.type === "toolCall");
			const { stopReason, errorDetail } = mapFinishReason(lastRawFinishReason, hasToolCalls);
			output.stopReason = stopReason;
			if (stopReason === "error") {
				output.errorMessage = errorDetail;
				stream.push({ type: "error", reason: "error", error: output });
			} else {
				stream.push({ type: "done", reason: stopReason, message: output });
			}
			stream.end();
		} catch (err) {
			closeCurrentBlock();
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = err instanceof Error ? err.message : String(err);
			stream.push({
				type: "error",
				reason: output.stopReason,
				error: output,
			});
			stream.end();
		}
	})();

	return stream;
}
