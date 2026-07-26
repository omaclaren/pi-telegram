import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { homedir } from "node:os";

import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

interface TelegramConfig {
	botToken?: string;
	botUsername?: string;
	botId?: number;
	allowedUserId?: number;
	lastUpdateId?: number;
}

interface TelegramApiResponse<T> {
	ok: boolean;
	result?: T;
	description?: string;
	error_code?: number;
}

interface TelegramUser {
	id: number;
	is_bot: boolean;
	first_name: string;
	username?: string;
}

interface TelegramChat {
	id: number;
	type: string;
}

interface TelegramPhotoSize {
	file_id: string;
	file_size?: number;
}

interface TelegramDocument {
	file_id: string;
	file_name?: string;
	mime_type?: string;
	file_size?: number;
}

interface TelegramVideo {
	file_id: string;
	file_name?: string;
	mime_type?: string;
	file_size?: number;
}

interface TelegramAudio {
	file_id: string;
	file_name?: string;
	mime_type?: string;
	file_size?: number;
}

interface TelegramVoice {
	file_id: string;
	mime_type?: string;
	file_size?: number;
}

interface TelegramAnimation {
	file_id: string;
	file_name?: string;
	mime_type?: string;
	file_size?: number;
}

interface TelegramSticker {
	file_id: string;
	emoji?: string;
}

interface TelegramFileInfo {
	file_id: string;
	fileName: string;
	mimeType?: string;
	isImage: boolean;
}

interface TelegramMessage {
	message_id: number;
	chat: TelegramChat;
	from?: TelegramUser;
	text?: string;
	caption?: string;
	media_group_id?: string;
	photo?: TelegramPhotoSize[];
	document?: TelegramDocument;
	video?: TelegramVideo;
	audio?: TelegramAudio;
	voice?: TelegramVoice;
	animation?: TelegramAnimation;
	sticker?: TelegramSticker;
}

interface TelegramUpdate {
	update_id: number;
	message?: TelegramMessage;
	edited_message?: TelegramMessage;
}

interface TelegramGetFileResult {
	file_path: string;
}

interface TelegramSentMessage {
	message_id: number;
}

interface DownloadedTelegramFile {
	path: string;
	fileName: string;
	isImage: boolean;
	mimeType?: string;
}

interface PendingTelegramTurn {
	chatId: number;
	replyToMessageId: number;
	queuedAttachments: QueuedAttachment[];
	content: Array<TextContent | ImageContent>;
	historyText: string;
}

type ActiveTelegramTurn = PendingTelegramTurn;

interface QueuedAttachment {
	path: string;
	fileName: string;
}

interface TelegramPreviewState {
	mode: "draft" | "message";
	draftId?: number;
	messageId?: number;
	pendingText: string;
	lastSentText: string;
	flushTimer?: ReturnType<typeof setTimeout>;
}

interface TelegramMediaGroupState {
	messages: TelegramMessage[];
	flushTimer?: ReturnType<typeof setTimeout>;
}

const CONFIG_PATH = join(homedir(), ".pi", "agent", "telegram.json");
const INBOUND_LOG_PATH = join(homedir(), ".pi", "agent", "telegram-inbound-log.md");
const TEMP_DIR = join(homedir(), ".pi", "agent", "tmp", "telegram");
const TELEGRAM_PREFIX = "[telegram]";
const MAX_MESSAGE_LENGTH = 4096;
const MAX_ATTACHMENTS_PER_TURN = 10;
const PREVIEW_THROTTLE_MS = 750;
// Disable streaming previews for now. The sendMessage/editMessageText preview
// path can leave duplicate raw-preview + rendered-final messages, especially
// for long replies. Final replies still render through Telegram HTML.
const ENABLE_STREAMING_PREVIEW = false;
const TELEGRAM_DRAFT_ID_MAX = 2_147_483_647;
const TELEGRAM_MEDIA_GROUP_DEBOUNCE_MS = 1200;

const SYSTEM_PROMPT_SUFFIX = `

Telegram bridge extension is active.
- Messages forwarded from Telegram are prefixed with "[telegram]".
- [telegram] messages may include local temp file paths for Telegram attachments. Read those files as needed.
- If a [telegram] user asked for a file or generated artifact, use the telegram_attach tool with the local file path so the extension can send it with your next final reply.
- Do not assume mentioning a local file path in plain text will send it to Telegram. Use telegram_attach.`;

function trimLogValue(value: string, limit = 700): string {
	const normalized = value.replace(/\s+/g, " ").trim();
	return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized;
}

function describeTelegramMessage(message: TelegramMessage): string {
	const parts = [`message=${message.message_id}`, `chat=${message.chat.id}`, `chat_type=${message.chat.type}`];
	if (message.from) parts.push(`from=${message.from.id}`);
	const text = trimLogValue(message.text || message.caption || "");
	if (text) parts.push(`text=${JSON.stringify(text)}`);
	const attachmentTypes = [
		message.photo ? "photo" : undefined,
		message.document ? "document" : undefined,
		message.video ? "video" : undefined,
		message.audio ? "audio" : undefined,
		message.voice ? "voice" : undefined,
		message.animation ? "animation" : undefined,
		message.sticker ? "sticker" : undefined,
	].filter((type): type is string => Boolean(type));
	if (attachmentTypes.length > 0) parts.push(`attachments=${attachmentTypes.join(",")}`);
	if (message.media_group_id) parts.push(`media_group=${message.media_group_id}`);
	return parts.join(" ");
}

function describeTelegramUpdate(update: TelegramUpdate): string {
	const message = update.message || update.edited_message;
	const updateType = update.edited_message ? "edited_message" : update.message ? "message" : "none";
	return [`update=${update.update_id}`, `type=${updateType}`, message ? describeTelegramMessage(message) : "no_message"].join(" ");
}

async function appendInboundLog(status: string, details: string): Promise<void> {
	try {
		await mkdir(join(homedir(), ".pi", "agent"), { recursive: true });
		const timestamp = new Date().toISOString();
		await appendFile(INBOUND_LOG_PATH, `- ${timestamp} | ${status} | ${details}\n`, "utf8");
	} catch {
		// Logging should never break Telegram message handling.
	}
}

function isTelegramPrompt(prompt: string): boolean {
	return prompt.trimStart().startsWith(TELEGRAM_PREFIX);
}

function sanitizeFileName(name: string): string {
	return name.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

function guessExtensionFromMime(mimeType: string | undefined, fallback: string): string {
	if (!mimeType) return fallback;
	const normalized = mimeType.toLowerCase();
	if (normalized === "image/jpeg") return ".jpg";
	if (normalized === "image/png") return ".png";
	if (normalized === "image/webp") return ".webp";
	if (normalized === "image/gif") return ".gif";
	if (normalized === "audio/ogg") return ".ogg";
	if (normalized === "audio/mpeg") return ".mp3";
	if (normalized === "audio/wav") return ".wav";
	if (normalized === "video/mp4") return ".mp4";
	if (normalized === "application/pdf") return ".pdf";
	return fallback;
}

function guessMediaType(path: string): string | undefined {
	const ext = extname(path).toLowerCase();
	if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
	if (ext === ".png") return "image/png";
	if (ext === ".webp") return "image/webp";
	if (ext === ".gif") return "image/gif";
	return undefined;
}

function isImageMimeType(mimeType: string | undefined): boolean {
	return mimeType?.toLowerCase().startsWith("image/") ?? false;
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

function chunkParagraphs(text: string, limit = MAX_MESSAGE_LENGTH): string[] {
	if (text.length <= limit) return [text];

	const normalized = text.replace(/\r\n/g, "\n");
	const paragraphs = normalized.split(/\n\n+/);
	const chunks: string[] = [];
	let current = "";

	const flushCurrent = (): void => {
		if (current.trim().length > 0) chunks.push(current);
		current = "";
	};

	const splitLongBlock = (block: string): string[] => {
		if (block.length <= limit) return [block];
		const lines = block.split("\n");
		const lineChunks: string[] = [];
		let lineCurrent = "";
		for (const line of lines) {
			const candidate = lineCurrent.length === 0 ? line : `${lineCurrent}\n${line}`;
			if (candidate.length <= limit) {
				lineCurrent = candidate;
				continue;
			}
			if (lineCurrent.length > 0) {
				lineChunks.push(lineCurrent);
				lineCurrent = "";
			}
			if (line.length <= limit) {
				lineCurrent = line;
				continue;
			}
			for (let i = 0; i < line.length; i += limit) {
				lineChunks.push(line.slice(i, i + limit));
			}
		}
		if (lineCurrent.length > 0) lineChunks.push(lineCurrent);
		return lineChunks;
	};

	for (const paragraph of paragraphs) {
		if (paragraph.length === 0) continue;
		const parts = splitLongBlock(paragraph);
		for (const part of parts) {
			const candidate = current.length === 0 ? part : `${current}\n\n${part}`;
			if (candidate.length <= limit) {
				current = candidate;
			} else {
				flushCurrent();
				current = part;
			}
		}
	}
	flushCurrent();
	return chunks;
}

function escapeTelegramHtml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderTelegramInlineMarkdown(text: string): string {
	const placeholders: string[] = [];
	let escaped = escapeTelegramHtml(text);
	escaped = escaped.replace(/`([^`\n]+)`/g, (_match, code: string) => {
		const token = `\u0000${placeholders.length}\u0000`;
		placeholders.push(`<code>${code}</code>`);
		return token;
	});
	escaped = escaped.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_match, label: string, url: string) => {
		const safeUrl = url.replace(/"/g, "&quot;");
		return `<a href="${safeUrl}">${label}</a>`;
	});
	escaped = escaped.replace(/\*\*([^*\n][\s\S]*?[^*\n])\*\*/g, "<b>$1</b>");
	escaped = escaped.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "<i>$1</i>");
	for (let i = 0; i < placeholders.length; i++) {
		const token = `\u0000${i}\u0000`;
		escaped = escaped.split(token).join(placeholders[i]);
	}
	return escaped;
}

function renderTelegramMarkdown(text: string): string {
	const normalized = text.replace(/\r\n/g, "\n");
	const lines = normalized.split("\n");
	const out: string[] = [];
	let inFence = false;
	let codeLines: string[] = [];

	for (const line of lines) {
		if (line.trimStart().startsWith("```")) {
			if (inFence) {
				out.push(`<pre><code>${escapeTelegramHtml(codeLines.join("\n"))}</code></pre>`);
				codeLines = [];
				inFence = false;
			} else {
				inFence = true;
				codeLines = [];
			}
			continue;
		}
		if (inFence) {
			codeLines.push(line);
			continue;
		}

		const heading = /^(#{1,6})\s+(.+)$/.exec(line);
		if (heading) {
			out.push(`<b>${renderTelegramInlineMarkdown(heading[2])}</b>`);
			continue;
		}
		const unordered = /^\s*[-*]\s+(.+)$/.exec(line);
		if (unordered) {
			out.push(`• ${renderTelegramInlineMarkdown(unordered[1])}`);
			continue;
		}
		const ordered = /^\s*(\d+)\.\s+(.+)$/.exec(line);
		if (ordered) {
			out.push(`${ordered[1]}. ${renderTelegramInlineMarkdown(ordered[2])}`);
			continue;
		}
		out.push(renderTelegramInlineMarkdown(line));
	}
	if (inFence) out.push(`<pre><code>${escapeTelegramHtml(codeLines.join("\n"))}</code></pre>`);
	return out.join("\n").trim();
}

async function readConfig(): Promise<TelegramConfig> {
	try {
		const content = await readFile(CONFIG_PATH, "utf8");
		const parsed = JSON.parse(content) as TelegramConfig;
		return parsed;
	} catch {
		return {};
	}
}

async function writeConfig(config: TelegramConfig): Promise<void> {
	await mkdir(join(homedir(), ".pi", "agent"), { recursive: true });
	await writeFile(CONFIG_PATH, JSON.stringify(config, null, "\t") + "\n", "utf8");
}

export default function (pi: ExtensionAPI) {
	let config: TelegramConfig = {};
	let pollingController: AbortController | undefined;
	let pollingPromise: Promise<void> | undefined;
	let queuedTelegramTurns: PendingTelegramTurn[] = [];
	let activeTelegramTurn: ActiveTelegramTurn | undefined;
	let typingInterval: ReturnType<typeof setInterval> | undefined;
	let currentAbort: (() => void) | undefined;
	let preserveQueuedTurnsAsHistory = false;
	let setupInProgress = false;
	let previewState: TelegramPreviewState | undefined;
	let latestTelegramAssistant: AgentMessage | undefined;
	let activeTelegramPromptStarted = false;
	let pendingTelegramStartTurn: PendingTelegramTurn | undefined;
	// Telegram draft streaming can leave a ghost/blank draft bubble in some
	// mobile clients and appears to interfere with outgoing message send state.
	// Prefer the older sendMessage/editMessageText preview path by default.
	let draftSupport: "unknown" | "supported" | "unsupported" = "unsupported";
	let nextDraftId = 0;
	const mediaGroups = new Map<string, TelegramMediaGroupState>();

	function allocateDraftId(): number {
		nextDraftId = nextDraftId >= TELEGRAM_DRAFT_ID_MAX ? 1 : nextDraftId + 1;
		return nextDraftId;
	}

	function updateStatus(ctx: ExtensionContext, error?: string): void {
		const theme = ctx.ui.theme;
		const label = theme.fg("accent", "telegram");
		if (error) {
			ctx.ui.setStatus("telegram", `${label} ${theme.fg("error", "error")} ${theme.fg("muted", error)}`);
			return;
		}
		if (!config.botToken) {
			ctx.ui.setStatus("telegram", `${label} ${theme.fg("muted", "not configured")}`);
			return;
		}
		if (!pollingPromise) {
			ctx.ui.setStatus("telegram", `${label} ${theme.fg("muted", "disconnected")}`);
			return;
		}
		if (!config.allowedUserId) {
			ctx.ui.setStatus("telegram", `${label} ${theme.fg("warning", "awaiting pairing")}`);
			return;
		}
		if (activeTelegramTurn || queuedTelegramTurns.length > 0) {
			const queued = queuedTelegramTurns.length > 0 ? theme.fg("muted", ` +${queuedTelegramTurns.length} queued`) : "";
			ctx.ui.setStatus("telegram", `${label} ${theme.fg("accent", "processing")}${queued}`);
			return;
		}
		ctx.ui.setStatus("telegram", `${label} ${theme.fg("success", "connected")}`);
	}

	async function callTelegram<TResponse>(
		method: string,
		body: Record<string, unknown>,
		options?: { signal?: AbortSignal },
	): Promise<TResponse> {
		if (!config.botToken) throw new Error("Telegram bot token is not configured");
		const response = await fetch(`https://api.telegram.org/bot${config.botToken}/${method}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
			signal: options?.signal,
		});
			const data = (await response.json()) as TelegramApiResponse<TResponse>;
		if (!data.ok || data.result === undefined) {
			throw new Error(data.description || `Telegram API ${method} failed`);
		}
		return data.result;
	}

	async function callTelegramMultipart<TResponse>(
		method: string,
		fields: Record<string, string>,
		fileField: string,
		filePath: string,
		fileName: string,
		options?: { signal?: AbortSignal },
	): Promise<TResponse> {
		if (!config.botToken) throw new Error("Telegram bot token is not configured");
		const form = new FormData();
		for (const [key, value] of Object.entries(fields)) {
			form.set(key, value);
		}
		const buffer = await readFile(filePath);
		form.set(fileField, new Blob([buffer]), fileName);
		const response = await fetch(`https://api.telegram.org/bot${config.botToken}/${method}`, {
			method: "POST",
			body: form,
			signal: options?.signal,
		});
		const data = (await response.json()) as TelegramApiResponse<TResponse>;
		if (!data.ok || data.result === undefined) {
			throw new Error(data.description || `Telegram API ${method} failed`);
		}
		return data.result;
	}

	async function downloadTelegramFile(fileId: string, suggestedName: string): Promise<string> {
		if (!config.botToken) throw new Error("Telegram bot token is not configured");
		const file = await callTelegram<TelegramGetFileResult>("getFile", { file_id: fileId });
		await mkdir(TEMP_DIR, { recursive: true });
		const targetPath = join(TEMP_DIR, `${Date.now()}-${sanitizeFileName(suggestedName)}`);
		const response = await fetch(`https://api.telegram.org/file/bot${config.botToken}/${file.file_path}`);
		if (!response.ok) throw new Error(`Failed to download Telegram file: ${response.status}`);
		const arrayBuffer = await response.arrayBuffer();
		await writeFile(targetPath, Buffer.from(arrayBuffer));
		return targetPath;
	}

	function startTypingLoop(ctx: ExtensionContext, chatId?: number): void {
		const targetChatId = chatId ?? activeTelegramTurn?.chatId;
		if (typingInterval || targetChatId === undefined) return;

		const sendTyping = async (): Promise<void> => {
			try {
				await callTelegram("sendChatAction", { chat_id: targetChatId, action: "typing" });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				updateStatus(ctx, `typing failed: ${message}`);
			}
		};

		void sendTyping();
		typingInterval = setInterval(() => {
			void sendTyping();
		}, 4000);
	}

	function stopTypingLoop(): void {
		if (!typingInterval) return;
		clearInterval(typingInterval);
		typingInterval = undefined;
	}

	function isAssistantMessage(message: AgentMessage): boolean {
		return (message as unknown as { role?: string }).role === "assistant";
	}

	function isUserMessage(message: AgentMessage): boolean {
		return (message as unknown as { role?: string }).role === "user";
	}

	function getTelegramTurnPromptText(turn: PendingTelegramTurn): string {
		return turn.content
			.filter((block): block is TextContent => block.type === "text")
			.map((block) => block.text)
			.join("\n")
			.trim();
	}

	function getMessageText(message: AgentMessage): string {
		const value = message as unknown as Record<string, unknown>;
		const content = Array.isArray(value.content) ? value.content : [];
		return content
			.filter((block): block is { type: string; text?: string } => typeof block === "object" && block !== null && "type" in block)
			.filter((block) => block.type === "text" && typeof block.text === "string")
			.map((block) => block.text as string)
			.join("")
			.trim();
	}

	function getErrorMessage(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}

	function isTelegramMessageNotModifiedError(error: unknown): boolean {
		return getErrorMessage(error).toLowerCase().includes("message is not modified");
	}

	async function clearPreview(chatId: number): Promise<void> {
		const state = previewState;
		if (!state) return;
		if (state.flushTimer) {
			clearTimeout(state.flushTimer);
			state.flushTimer = undefined;
		}
		previewState = undefined;
		if (state.mode === "draft" && state.draftId !== undefined) {
			try {
				await callTelegram("sendMessageDraft", { chat_id: chatId, draft_id: state.draftId, text: "" });
			} catch {
				// ignore
			}
		}
	}

	async function flushPreview(chatId: number): Promise<void> {
		const state = previewState;
		if (!state) return;
		state.flushTimer = undefined;
		const text = state.pendingText.trim();
		if (!text) return;
		const truncated = text.length > MAX_MESSAGE_LENGTH ? text.slice(0, MAX_MESSAGE_LENGTH) : text;
		if (truncated === state.lastSentText) return;

		if (draftSupport !== "unsupported") {
			const draftId = state.draftId ?? allocateDraftId();
			state.draftId = draftId;
			try {
				await callTelegram("sendMessageDraft", { chat_id: chatId, draft_id: draftId, text: truncated });
				draftSupport = "supported";
				state.mode = "draft";
				state.lastSentText = truncated;
				return;
			} catch {
				draftSupport = "unsupported";
			}
		}

		if (state.messageId === undefined) {
			const sent = await callTelegram<TelegramSentMessage>("sendMessage", { chat_id: chatId, text: truncated });
			state.messageId = sent.message_id;
			state.mode = "message";
			state.lastSentText = truncated;
			return;
		}
		try {
			await callTelegram("editMessageText", { chat_id: chatId, message_id: state.messageId, text: truncated });
		} catch (error) {
			if (!isTelegramMessageNotModifiedError(error)) throw error;
		}
		state.mode = "message";
		state.lastSentText = truncated;
	}

	function schedulePreviewFlush(chatId: number, ctx: ExtensionContext): void {
		if (!previewState || previewState.flushTimer) return;
		previewState.flushTimer = setTimeout(() => {
			void flushPreview(chatId).catch((error) => {
				if (isTelegramMessageNotModifiedError(error)) return;
				updateStatus(ctx, `preview failed: ${getErrorMessage(error)}`);
			});
		}, PREVIEW_THROTTLE_MS);
	}

	async function sendRenderedTelegramMessage(chatId: number, text: string): Promise<TelegramSentMessage> {
		const rendered = renderTelegramMarkdown(text);
		if (rendered.length > 0 && rendered.length <= MAX_MESSAGE_LENGTH) {
			try {
				return await callTelegram<TelegramSentMessage>("sendMessage", {
					chat_id: chatId,
					text: rendered,
					parse_mode: "HTML",
				});
			} catch {
				// Fall back to plain text if Telegram rejects the generated HTML.
			}
		}
		return await callTelegram<TelegramSentMessage>("sendMessage", { chat_id: chatId, text });
	}

	async function editRenderedTelegramMessage(chatId: number, messageId: number, text: string): Promise<void> {
		const rendered = renderTelegramMarkdown(text);
		if (rendered.length > 0 && rendered.length <= MAX_MESSAGE_LENGTH) {
			try {
				await callTelegram("editMessageText", {
					chat_id: chatId,
					message_id: messageId,
					text: rendered,
					parse_mode: "HTML",
				});
				return;
			} catch (error) {
				if (isTelegramMessageNotModifiedError(error)) return;
				// Fall back to plain text if Telegram rejects the generated HTML.
			}
		}
		try {
			await callTelegram("editMessageText", { chat_id: chatId, message_id: messageId, text });
		} catch (error) {
			if (!isTelegramMessageNotModifiedError(error)) throw error;
		}
	}

	async function finalizePreview(chatId: number): Promise<boolean> {
		const state = previewState;
		if (!state) return false;
		await flushPreview(chatId);
		const finalText = (state.pendingText.trim() || state.lastSentText).trim();
		if (!finalText) {
			await clearPreview(chatId);
			return false;
		}
		if (state.mode === "draft") {
			await sendRenderedTelegramMessage(chatId, finalText);
			await clearPreview(chatId);
			return true;
		}
		previewState = undefined;
		if (state.messageId !== undefined) {
			await editRenderedTelegramMessage(chatId, state.messageId, finalText);
			return true;
		}
		return false;
	}

	async function sendTextReply(chatId: number, _replyToMessageId: number, text: string): Promise<number | undefined> {
		const chunks = chunkParagraphs(text, 3500);
		let lastMessageId: number | undefined;
		for (const chunk of chunks) {
			const sent = await sendRenderedTelegramMessage(chatId, chunk);
			lastMessageId = sent.message_id;
		}
		return lastMessageId;
	}

	async function sendQueuedAttachments(turn: ActiveTelegramTurn): Promise<void> {
		for (const attachment of turn.queuedAttachments) {
			try {
				const mediaType = guessMediaType(attachment.path);
				const method = mediaType ? "sendPhoto" : "sendDocument";
				const fieldName = mediaType ? "photo" : "document";
				await callTelegramMultipart<TelegramSentMessage>(
					method,
					{
						chat_id: String(turn.chatId),
					},
					fieldName,
					attachment.path,
					attachment.fileName,
				);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				await sendTextReply(turn.chatId, turn.replyToMessageId, `Failed to send attachment ${attachment.fileName}: ${message}`);
			}
		}
	}

	function extractAssistantText(messages: AgentMessage[]): { text?: string; stopReason?: string; errorMessage?: string } {
		for (let i = messages.length - 1; i >= 0; i--) {
			const message = messages[i] as unknown as Record<string, unknown>;
			if (message.role !== "assistant") continue;
			const stopReason = typeof message.stopReason === "string" ? message.stopReason : undefined;
			const errorMessage = typeof message.errorMessage === "string" ? message.errorMessage : undefined;
			const content = Array.isArray(message.content) ? message.content : [];
			const text = content
				.filter((block): block is { type: string; text?: string } => typeof block === "object" && block !== null && "type" in block)
				.filter((block) => block.type === "text" && typeof block.text === "string")
				.map((block) => block.text as string)
				.join("")
				.trim();
			return { text: text || undefined, stopReason, errorMessage };
		}
		return {};
	}

	async function finalizeActiveTelegramTurn(ctx: ExtensionContext): Promise<void> {
		const turn = activeTelegramTurn;
		if (!turn) return;

		const assistant = extractAssistantText(latestTelegramAssistant ? [latestTelegramAssistant] : []);
		activeTelegramTurn = undefined;
		latestTelegramAssistant = undefined;
		activeTelegramPromptStarted = false;
		currentAbort = undefined;
		stopTypingLoop();
		updateStatus(ctx);

		if (assistant.stopReason === "aborted") {
			await clearPreview(turn.chatId);
			return;
		}
		if (assistant.stopReason === "error") {
			// Reaching this function means Pi has exhausted automatic recovery for
			// this prompt, or a later user prompt has begun.
			await clearPreview(turn.chatId);
			await sendTextReply(
				turn.chatId,
				turn.replyToMessageId,
				assistant.errorMessage || "Telegram bridge: pi failed while processing the request.",
			);
			await appendInboundLog("reply_error", `chat=${turn.chatId} reply_to=${turn.replyToMessageId}`);
			return;
		}

		const finalText = assistant.text;
		if (previewState) {
			previewState.pendingText = finalText ?? previewState.pendingText;
		}

		if (finalText && finalText.length <= MAX_MESSAGE_LENGTH) {
			const finalized = await finalizePreview(turn.chatId);
			if (!finalized) {
				await sendTextReply(turn.chatId, turn.replyToMessageId, finalText);
			}
		} else {
			await clearPreview(turn.chatId);
			if (finalText) {
				await sendTextReply(turn.chatId, turn.replyToMessageId, finalText);
			} else if (turn.queuedAttachments.length > 0) {
				await sendTextReply(turn.chatId, turn.replyToMessageId, "Attached requested file(s).");
			} else {
				await sendTextReply(turn.chatId, turn.replyToMessageId, "Telegram bridge: pi finished without a final response.");
			}
		}

		await sendQueuedAttachments(turn);
		await appendInboundLog(
			"reply_sent",
			`chat=${turn.chatId} reply_to=${turn.replyToMessageId} attachments=${turn.queuedAttachments.length}`,
		);
	}

	function removeQueuedTelegramTurn(turn: PendingTelegramTurn): void {
		const index = queuedTelegramTurns.indexOf(turn);
		if (index >= 0) queuedTelegramTurns.splice(index, 1);
	}

	async function reportTelegramStartFailure(
		turn: PendingTelegramTurn,
		ctx: ExtensionContext,
		reason: string,
	): Promise<void> {
		removeQueuedTelegramTurn(turn);
		if (pendingTelegramStartTurn === turn) pendingTelegramStartTurn = undefined;
		stopTypingLoop();
		updateStatus(ctx);
		await sendTextReply(turn.chatId, turn.replyToMessageId, `Telegram bridge could not start pi: ${reason}`);
		await appendInboundLog(
			"start_failed",
			`chat=${turn.chatId} reply_to=${turn.replyToMessageId} error=${JSON.stringify(reason)}`,
		);
	}

	async function forwardNextQueuedTelegramTurn(ctx: ExtensionContext): Promise<void> {
		if (activeTelegramTurn || pendingTelegramStartTurn || preserveQueuedTurnsAsHistory || !ctx.isIdle()) return;

		while (queuedTelegramTurns.length > 0) {
			const turn = queuedTelegramTurns[0];
			if (!ctx.model) {
				await reportTelegramStartFailure(turn, ctx, "no model is selected");
				continue;
			}

			try {
				const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
				if (!auth.ok) {
					await reportTelegramStartFailure(turn, ctx, auth.error);
					continue;
				}
			} catch (error) {
				await reportTelegramStartFailure(turn, ctx, getErrorMessage(error));
				continue;
			}

			pendingTelegramStartTurn = turn;
			startTypingLoop(ctx, turn.chatId);
			updateStatus(ctx);
			pi.sendUserMessage(turn.content, { deliverAs: "followUp" });
			await appendInboundLog("forwarded", `chat=${turn.chatId} reply_to=${turn.replyToMessageId} deliverAs=followUp`);
			return;
		}
	}

	function collectTelegramFileInfos(messages: TelegramMessage[]): TelegramFileInfo[] {
		const files: TelegramFileInfo[] = [];
		for (const message of messages) {
			if (Array.isArray(message.photo) && message.photo.length > 0) {
				const photo = [...message.photo].sort((a, b) => (a.file_size ?? 0) - (b.file_size ?? 0)).pop();
				if (photo) {
					files.push({
						file_id: photo.file_id,
						fileName: `photo-${message.message_id}.jpg`,
						mimeType: "image/jpeg",
						isImage: true,
					});
				}
			}
			if (message.document) {
				const fileName = message.document.file_name || `document-${message.message_id}${guessExtensionFromMime(message.document.mime_type, "")}`;
				files.push({
					file_id: message.document.file_id,
					fileName,
					mimeType: message.document.mime_type,
					isImage: isImageMimeType(message.document.mime_type),
				});
			}
			if (message.video) {
				const fileName = message.video.file_name || `video-${message.message_id}${guessExtensionFromMime(message.video.mime_type, ".mp4")}`;
				files.push({
					file_id: message.video.file_id,
					fileName,
					mimeType: message.video.mime_type,
					isImage: false,
				});
			}
			if (message.audio) {
				const fileName = message.audio.file_name || `audio-${message.message_id}${guessExtensionFromMime(message.audio.mime_type, ".mp3")}`;
				files.push({
					file_id: message.audio.file_id,
					fileName,
					mimeType: message.audio.mime_type,
					isImage: false,
				});
			}
			if (message.voice) {
				files.push({
					file_id: message.voice.file_id,
					fileName: `voice-${message.message_id}${guessExtensionFromMime(message.voice.mime_type, ".ogg")}`,
					mimeType: message.voice.mime_type,
					isImage: false,
				});
			}
			if (message.animation) {
				const fileName = message.animation.file_name || `animation-${message.message_id}${guessExtensionFromMime(message.animation.mime_type, ".mp4")}`;
				files.push({
					file_id: message.animation.file_id,
					fileName,
					mimeType: message.animation.mime_type,
					isImage: false,
				});
			}
			if (message.sticker) {
				files.push({
					file_id: message.sticker.file_id,
					fileName: `sticker-${message.message_id}.webp`,
					mimeType: "image/webp",
					isImage: true,
				});
			}
		}
		return files;
	}

	async function buildTelegramFiles(messages: TelegramMessage[]): Promise<DownloadedTelegramFile[]> {
		const downloaded: DownloadedTelegramFile[] = [];
		for (const file of collectTelegramFileInfos(messages)) {
			const path = await downloadTelegramFile(file.file_id, file.fileName);
			downloaded.push({ path, fileName: file.fileName, isImage: file.isImage, mimeType: file.mimeType });
		}
		return downloaded;
	}

	async function promptForConfig(ctx: ExtensionContext): Promise<void> {
		if (!ctx.hasUI || setupInProgress) return;
		setupInProgress = true;
		try {
			const token = await ctx.ui.input("Telegram bot token", "123456:ABCDEF...");
			if (!token) return;

			const nextConfig: TelegramConfig = { ...config, botToken: token.trim() };
			const response = await fetch(`https://api.telegram.org/bot${nextConfig.botToken}/getMe`);
			const data = (await response.json()) as TelegramApiResponse<TelegramUser>;
			if (!data.ok || !data.result) {
				ctx.ui.notify(data.description || "Invalid Telegram bot token", "error");
				return;
			}

			nextConfig.botId = data.result.id;
			nextConfig.botUsername = data.result.username;
			config = nextConfig;
			await writeConfig(config);
			ctx.ui.notify(`Telegram bot connected: @${config.botUsername ?? "unknown"}`, "info");
			ctx.ui.notify("Send /start to your bot in Telegram to pair this extension with your account.", "info");
			await startPolling(ctx);
			updateStatus(ctx);
		} finally {
			setupInProgress = false;
		}
	}

	async function stopPolling(): Promise<void> {
		stopTypingLoop();
		pollingController?.abort();
		pollingController = undefined;
		await pollingPromise?.catch(() => undefined);
		pollingPromise = undefined;
	}

	function formatTelegramHistoryText(rawText: string, files: DownloadedTelegramFile[]): string {
		let summary = rawText.length > 0 ? rawText : "(no text)";
		if (files.length > 0) {
			summary += `\nAttachments:`;
			for (const file of files) {
				summary += `\n- ${file.path}`;
			}
		}
		return summary;
	}

	async function createTelegramTurn(
		messages: TelegramMessage[],
		historyTurns: PendingTelegramTurn[] = [],
	): Promise<PendingTelegramTurn> {
		const firstMessage = messages[0];
		if (!firstMessage) throw new Error("Missing Telegram message for turn creation");
		const rawText = messages.map((message) => (message.text || message.caption || "").trim()).filter(Boolean).join("\n\n");
		const files = await buildTelegramFiles(messages);
		const content: Array<TextContent | ImageContent> = [];
		let prompt = `${TELEGRAM_PREFIX}`;

		if (historyTurns.length > 0) {
			prompt += `\n\nEarlier Telegram messages arrived after an aborted turn. Treat them as prior user messages, in order:`;
			for (const [index, turn] of historyTurns.entries()) {
				prompt += `\n\n${index + 1}. ${turn.historyText}`;
			}
			prompt += `\n\nCurrent Telegram message:`;
		}

		if (rawText.length > 0) {
			prompt += historyTurns.length > 0 ? `\n${rawText}` : ` ${rawText}`;
		}
		if (files.length > 0) {
			prompt += `\n\nTelegram attachments were saved locally:`;
			for (const file of files) {
				prompt += `\n- ${file.path}`;
			}
		}
		content.push({ type: "text", text: prompt });

		for (const file of files) {
			if (!file.isImage) continue;
			const mediaType = file.mimeType || guessMediaType(file.path);
			if (!mediaType) continue;
			const buffer = await readFile(file.path);
			content.push({
				type: "image",
				data: buffer.toString("base64"),
				mimeType: mediaType,
			});
		}

		return {
			chatId: firstMessage.chat.id,
			replyToMessageId: firstMessage.message_id,
			queuedAttachments: [],
			content,
			historyText: formatTelegramHistoryText(rawText, files),
		};
	}

	async function dispatchAuthorizedTelegramMessages(messages: TelegramMessage[], ctx: ExtensionContext): Promise<void> {
		const firstMessage = messages[0];
		if (!firstMessage) return;
		await appendInboundLog("dispatching", `count=${messages.length} ${describeTelegramMessage(firstMessage)}`);
		const rawText = messages.map((message) => (message.text || message.caption || "").trim()).find((text) => text.length > 0) || "";
		const lower = rawText.toLowerCase();

		if (lower === "stop" || lower === "/stop") {
			if (currentAbort) {
				if (queuedTelegramTurns.length > 0) {
					preserveQueuedTurnsAsHistory = true;
				}
				currentAbort();
				updateStatus(ctx);
				await sendTextReply(firstMessage.chat.id, firstMessage.message_id, "Aborted current turn.");
				await appendInboundLog("command_stop", `${describeTelegramMessage(firstMessage)} result=aborted`);
			} else {
				await sendTextReply(firstMessage.chat.id, firstMessage.message_id, "No active turn.");
				await appendInboundLog("command_stop", `${describeTelegramMessage(firstMessage)} result=no_active_turn`);
			}
			return;
		}

		if (lower === "/compact") {
			if (!ctx.isIdle()) {
				await sendTextReply(firstMessage.chat.id, firstMessage.message_id, "Cannot compact while pi is busy. Send \"stop\" first.");
				await appendInboundLog("command_compact", `${describeTelegramMessage(firstMessage)} result=busy`);
				return;
			}
			ctx.compact({
				onComplete: () => {
					void sendTextReply(firstMessage.chat.id, firstMessage.message_id, "Compaction completed.");
				},
				onError: (error) => {
					const message = error instanceof Error ? error.message : String(error);
					void sendTextReply(firstMessage.chat.id, firstMessage.message_id, `Compaction failed: ${message}`);
				},
			});
			await sendTextReply(firstMessage.chat.id, firstMessage.message_id, "Compaction started.");
			await appendInboundLog("command_compact", `${describeTelegramMessage(firstMessage)} result=started`);
			return;
		}

		if (lower === "/status") {
			let totalInput = 0;
			let totalOutput = 0;
			let totalCacheRead = 0;
			let totalCacheWrite = 0;
			let totalCost = 0;

			for (const entry of ctx.sessionManager.getEntries()) {
				if (entry.type !== "message" || entry.message.role !== "assistant") continue;
				totalInput += entry.message.usage.input;
				totalOutput += entry.message.usage.output;
				totalCacheRead += entry.message.usage.cacheRead;
				totalCacheWrite += entry.message.usage.cacheWrite;
				totalCost += entry.message.usage.cost.total;
			}

			const usage = ctx.getContextUsage();
			const lines: string[] = [];
			if (ctx.model) {
				lines.push(`Model: ${ctx.model.provider}/${ctx.model.id}`);
			}
			lines.push(`Telegram last update: ${config.lastUpdateId ?? "unknown"}`);
			lines.push(`Queued Telegram turns: ${queuedTelegramTurns.length}${activeTelegramTurn ? " (+active)" : ""}`);
			lines.push(`Inbound log: ${INBOUND_LOG_PATH}`);
			const tokenParts: string[] = [];
			if (totalInput) tokenParts.push(`↑${formatTokens(totalInput)}`);
			if (totalOutput) tokenParts.push(`↓${formatTokens(totalOutput)}`);
			if (totalCacheRead) tokenParts.push(`R${formatTokens(totalCacheRead)}`);
			if (totalCacheWrite) tokenParts.push(`W${formatTokens(totalCacheWrite)}`);
			if (tokenParts.length > 0) {
				lines.push(`Usage: ${tokenParts.join(" ")}`);
			}
			const usingSubscription = ctx.model ? ctx.modelRegistry.isUsingOAuth(ctx.model) : false;
			if (totalCost || usingSubscription) {
				lines.push(`Cost: $${totalCost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`);
			}
			if (usage) {
				const contextWindow = usage.contextWindow ?? ctx.model?.contextWindow ?? 0;
				const percent = usage.percent !== null ? `${usage.percent.toFixed(1)}%` : "?";
				lines.push(`Context: ${percent}/${formatTokens(contextWindow)}`);
			} else {
				lines.push("Context: unknown");
			}
			if (lines.length === 0) {
				lines.push("No usage data yet.");
			}
			await sendTextReply(firstMessage.chat.id, firstMessage.message_id, lines.join("\n"));
			await appendInboundLog("command_status", `${describeTelegramMessage(firstMessage)} result=sent`);
			return;
		}

		if (lower === "/help" || lower === "/start") {
			await sendTextReply(
				firstMessage.chat.id,
				firstMessage.message_id,
				`Send me a message and I will forward it to pi. Commands: /status, /compact, stop.`,
			);
			if (config.allowedUserId === undefined && firstMessage.from) {
				config.allowedUserId = firstMessage.from.id;
				await writeConfig(config);
				updateStatus(ctx);
				await appendInboundLog("paired", `${describeTelegramMessage(firstMessage)} user=${firstMessage.from.id}`);
			}
			await appendInboundLog("command_help", `${describeTelegramMessage(firstMessage)} result=sent`);
			return;
		}

		const historyTurns = preserveQueuedTurnsAsHistory ? queuedTelegramTurns.splice(0) : [];
		preserveQueuedTurnsAsHistory = false;
		const turn = await createTelegramTurn(messages, historyTurns);
		queuedTelegramTurns.push(turn);
		await appendInboundLog("queued", `${describeTelegramMessage(firstMessage)} queue=${queuedTelegramTurns.length} idle=${ctx.isIdle()}`);
		if (ctx.isIdle()) {
			await forwardNextQueuedTelegramTurn(ctx);
		}
	}

	async function handleAuthorizedTelegramMessage(message: TelegramMessage, ctx: ExtensionContext): Promise<void> {
		if (message.media_group_id) {
			const key = `${message.chat.id}:${message.media_group_id}`;
			const existing = mediaGroups.get(key) ?? { messages: [] };
			existing.messages.push(message);
			await appendInboundLog("media_group_buffered", `${describeTelegramMessage(message)} group_count=${existing.messages.length}`);
			if (existing.flushTimer) clearTimeout(existing.flushTimer);
			existing.flushTimer = setTimeout(() => {
				const state = mediaGroups.get(key);
				mediaGroups.delete(key);
				if (!state) return;
				void dispatchAuthorizedTelegramMessages(state.messages, ctx).catch((error) => {
					const errorMessage = error instanceof Error ? error.message : String(error);
					void appendInboundLog("errored", `media_group=${key} dispatch_error=${JSON.stringify(errorMessage)}`);
				});
			}, TELEGRAM_MEDIA_GROUP_DEBOUNCE_MS);
			mediaGroups.set(key, existing);
			return;
		}

		await dispatchAuthorizedTelegramMessages([message], ctx);
	}

	async function handleUpdate(update: TelegramUpdate, ctx: ExtensionContext): Promise<void> {
		const message = update.message || update.edited_message;
		if (!message) {
			await appendInboundLog("ignored", `${describeTelegramUpdate(update)} reason=no_message`);
			return;
		}
		if (message.chat.type !== "private") {
			await appendInboundLog("ignored", `${describeTelegramUpdate(update)} reason=non_private_chat`);
			return;
		}
		if (!message.from) {
			await appendInboundLog("ignored", `${describeTelegramUpdate(update)} reason=missing_sender`);
			return;
		}
		if (message.from.is_bot) {
			await appendInboundLog("ignored", `${describeTelegramUpdate(update)} reason=bot_sender`);
			return;
		}

		if (config.allowedUserId === undefined) {
			config.allowedUserId = message.from.id;
			await writeConfig(config);
			updateStatus(ctx);
			await sendTextReply(message.chat.id, message.message_id, "Telegram bridge paired with this account.");
			await appendInboundLog("paired", `${describeTelegramUpdate(update)} user=${message.from.id}`);
		}

		if (message.from.id !== config.allowedUserId) {
			await sendTextReply(message.chat.id, message.message_id, "This bot is not authorized for your account.");
			await appendInboundLog("unauthorized", `${describeTelegramUpdate(update)} allowed=${config.allowedUserId}`);
			return;
		}

		await appendInboundLog("authorized", describeTelegramUpdate(update));
		await handleAuthorizedTelegramMessage(message, ctx);
	}

	async function pollLoop(ctx: ExtensionContext, signal: AbortSignal): Promise<void> {
		if (!config.botToken) return;

		try {
			await callTelegram("deleteWebhook", { drop_pending_updates: false }, { signal });
		} catch {
			// ignore
		}

		if (config.lastUpdateId === undefined) {
			try {
				const updates = await callTelegram<TelegramUpdate[]>("getUpdates", { offset: -1, limit: 1, timeout: 0 }, { signal });
				const last = updates.at(-1);
				if (last) {
					config.lastUpdateId = last.update_id;
					await writeConfig(config);
				}
			} catch {
				// ignore
			}
		}

		while (!signal.aborted) {
			try {
				const updates = await callTelegram<TelegramUpdate[]>(
					"getUpdates",
					{
						offset: config.lastUpdateId !== undefined ? config.lastUpdateId + 1 : undefined,
						limit: 10,
						timeout: 30,
						allowed_updates: ["message", "edited_message"],
					},
					{ signal },
				);
				for (const update of updates) {
					await appendInboundLog("received", describeTelegramUpdate(update));
					try {
						await handleUpdate(update, ctx);
						config.lastUpdateId = update.update_id;
						await writeConfig(config);
						await appendInboundLog("acknowledged", describeTelegramUpdate(update));
					} catch (error) {
						const errorMessage = error instanceof Error ? error.message : String(error);
						await appendInboundLog("errored", `${describeTelegramUpdate(update)} error=${JSON.stringify(errorMessage)}`);
						throw error;
					}
				}
			} catch (error) {
				if (signal.aborted) return;
				if (error instanceof DOMException && error.name === "AbortError") return;
				const message = error instanceof Error ? error.message : String(error);
				updateStatus(ctx, message);
				await new Promise((resolve) => setTimeout(resolve, 3000));
				updateStatus(ctx);
			}
		}
	}

	async function startPolling(ctx: ExtensionContext): Promise<void> {
		if (!config.botToken || pollingPromise) return;
		pollingController = new AbortController();
		pollingPromise = pollLoop(ctx, pollingController.signal).finally(() => {
			pollingPromise = undefined;
			pollingController = undefined;
			updateStatus(ctx);
		});
		updateStatus(ctx);
	}

	pi.registerTool({
		name: "telegram_attach",
		label: "Telegram Attach",
		description: "Queue one or more local files to be sent with the next Telegram reply.",
		promptSnippet: "Queue local files to be sent with the next Telegram reply.",
		promptGuidelines: [
			"When handling a [telegram] message and the user asked for a file or generated artifact, call telegram_attach with the local path instead of only mentioning the path in text.",
		],
		parameters: Type.Object({
			paths: Type.Array(Type.String({ description: "Local file path to attach" }), { minItems: 1, maxItems: MAX_ATTACHMENTS_PER_TURN }),
		}),
		async execute(_toolCallId, params) {
			if (!activeTelegramTurn) {
				throw new Error("telegram_attach can only be used while replying to an active Telegram turn");
			}
			const added: string[] = [];
			for (const inputPath of params.paths) {
				const stats = await stat(inputPath);
				if (!stats.isFile()) {
					throw new Error(`Not a file: ${inputPath}`);
				}
				if (activeTelegramTurn.queuedAttachments.length >= MAX_ATTACHMENTS_PER_TURN) {
					throw new Error(`Attachment limit reached (${MAX_ATTACHMENTS_PER_TURN})`);
				}
				activeTelegramTurn.queuedAttachments.push({ path: inputPath, fileName: basename(inputPath) });
				added.push(inputPath);
			}
			return {
				content: [{ type: "text", text: `Queued ${added.length} Telegram attachment(s).` }],
				details: { paths: added },
			};
		},
	});

	pi.registerCommand("telegram-setup", {
		description: "Configure Telegram bot token",
		handler: async (_args, ctx) => {
			await promptForConfig(ctx);
		},
	});

	pi.registerCommand("telegram-status", {
		description: "Show Telegram bridge status",
		handler: async (_args, ctx) => {
			const status = [
				`bot: ${config.botUsername ? `@${config.botUsername}` : "not configured"}`,
				`allowed user: ${config.allowedUserId ?? "not paired"}`,
				`polling: ${pollingPromise ? "running" : "stopped"}`,
				`active telegram turn: ${activeTelegramTurn ? "yes" : "no"}`,
				`queued telegram turns: ${queuedTelegramTurns.length}`,
			];
			ctx.ui.notify(status.join(" | "), "info");
		},
	});

	pi.registerCommand("telegram-connect", {
		description: "Start the Telegram bridge in this pi session",
		handler: async (_args, ctx) => {
			config = await readConfig();
			if (!config.botToken) {
				await promptForConfig(ctx);
				return;
			}
			await startPolling(ctx);
			updateStatus(ctx);
		},
	});

	pi.registerCommand("telegram-disconnect", {
		description: "Stop the Telegram bridge in this pi session",
		handler: async (_args, ctx) => {
			await stopPolling();
			updateStatus(ctx);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		config = await readConfig();
		await mkdir(TEMP_DIR, { recursive: true });
		updateStatus(ctx);
	});

	pi.on("session_compact", async (_event, ctx) => {
		// Manual compaction does not emit agent_settled. Retry queued Telegram
		// delivery after the completed compaction handler returns to Pi.
		setTimeout(() => {
			void forwardNextQueuedTelegramTurn(ctx).catch((error) => {
				void appendInboundLog("errored", `post_compact_forward=${JSON.stringify(getErrorMessage(error))}`);
			});
		}, 0);
	});

	pi.on("session_shutdown", async (_event, _ctx) => {
		queuedTelegramTurns = [];
		for (const state of mediaGroups.values()) {
			if (state.flushTimer) clearTimeout(state.flushTimer);
		}
		mediaGroups.clear();
		if (activeTelegramTurn) {
			await clearPreview(activeTelegramTurn.chatId);
		}
		activeTelegramTurn = undefined;
		latestTelegramAssistant = undefined;
		activeTelegramPromptStarted = false;
		pendingTelegramStartTurn = undefined;
		currentAbort = undefined;
		preserveQueuedTurnsAsHistory = false;
		await stopPolling();
	});

	pi.on("before_agent_start", async (event) => {
		const suffix = isTelegramPrompt(event.prompt)
			? `${SYSTEM_PROMPT_SUFFIX}\n- The current user message came from Telegram.`
			: SYSTEM_PROMPT_SUFFIX;
		return {
			systemPrompt: event.systemPrompt + suffix,
		};
	});

	pi.on("agent_start", async (_event, ctx) => {
		currentAbort = () => ctx.abort();
		updateStatus(ctx);
	});

	pi.on("message_start", async (event, ctx) => {
		if (isUserMessage(event.message) && !activeTelegramTurn && pendingTelegramStartTurn) {
			const pendingTurn = pendingTelegramStartTurn;
			if (getMessageText(event.message) === getTelegramTurnPromptText(pendingTurn)) {
				// Correlate on the actual user message, not merely the next agent_start:
				// a local prompt can race with the fire-and-forget sendUserMessage call.
				removeQueuedTelegramTurn(pendingTurn);
				pendingTelegramStartTurn = undefined;
				activeTelegramTurn = { ...pendingTurn };
				latestTelegramAssistant = undefined;
				activeTelegramPromptStarted = false;
				previewState = { mode: draftSupport === "unsupported" ? "message" : "draft", pendingText: "", lastSentText: "" };
				startTypingLoop(ctx);
				updateStatus(ctx);
			}
		}

		if (!activeTelegramTurn) return;

		if (isUserMessage(event.message)) {
			if (!activeTelegramPromptStarted) {
				activeTelegramPromptStarted = true;
				return;
			}
			// Pi can process unrelated queued user messages before agent_settled.
			// Close the Telegram turn at that user-message boundary so a later local
			// continuation cannot be misattributed as Telegram's reply.
			await finalizeActiveTelegramTurn(ctx);
			return;
		}

		if (!isAssistantMessage(event.message)) return;
		if (ENABLE_STREAMING_PREVIEW) {
			if (previewState && (previewState.pendingText.trim().length > 0 || previewState.lastSentText.trim().length > 0)) {
				await finalizePreview(activeTelegramTurn.chatId);
			}
		} else {
			// Do not expose intermediate assistant messages (including transient
			// provider errors) when Telegram streaming previews are disabled.
			await clearPreview(activeTelegramTurn.chatId);
		}
		previewState = { mode: draftSupport === "unsupported" ? "message" : "draft", pendingText: "", lastSentText: "" };
	});

	pi.on("message_update", async (event, ctx) => {
		if (!activeTelegramTurn || !isAssistantMessage(event.message)) return;
		if (!previewState) {
			previewState = { mode: draftSupport === "unsupported" ? "message" : "draft", pendingText: "", lastSentText: "" };
		}
		previewState.pendingText = getMessageText(event.message);
		if (ENABLE_STREAMING_PREVIEW) {
			schedulePreviewFlush(activeTelegramTurn.chatId, ctx);
		}
	});

	pi.on("message_end", async (event, _ctx) => {
		if (!activeTelegramTurn || !isAssistantMessage(event.message)) return;
		latestTelegramAssistant = event.message;
	});

	pi.on("agent_settled", async (_event, ctx) => {
		currentAbort = undefined;
		await finalizeActiveTelegramTurn(ctx);

		// This also starts a Telegram turn that arrived while a local Pi turn was
		// busy, which the old agent_end-only flow could leave stranded.
		await forwardNextQueuedTelegramTurn(ctx);
	});
}
