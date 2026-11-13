import type { ProviderAuthInteraction } from "@earendil-works/pi-ai";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

export type AntigravityProviderId = "antigravity" | "antigravity-cli";

export const CCPA_BASE_URLS = [
	"https://daily-cloudcode-pa.googleapis.com",
	"https://cloudcode-pa.googleapis.com",
] as const;

export const CCPA_USER_AGENT =
	"antigravity/acp/1.5.0 (aidev_client; os_type=linux; arch=amd64; host_path=gentle-shell/1.5.0; proxy_client=antigravity/sdk)";

export const DEFAULT_PROJECT_ID = "aicode-consumers";

const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";
const DEFAULT_AUTH_URI = "https://accounts.google.com/o/oauth2/v2/auth";
const DEFAULT_SCOPES = [
	"https://www.googleapis.com/auth/cloud-platform",
	"https://www.googleapis.com/auth/userinfo.email",
	"https://www.googleapis.com/auth/userinfo.profile",
	"https://www.googleapis.com/auth/cclog",
	"https://www.googleapis.com/auth/experimentsandconfigs",
];

const EXPIRY_BUFFER_MS = 5 * 60_000;
const AUTH_FETCH_TIMEOUT_MS = 20_000;
const LOGIN_TIMEOUT_MS = 5 * 60_000;

export interface ResolvedAccountAuth {
	providerId: AntigravityProviderId;
	accessToken: string;
	expiresAt: number;
	projectId: string;
	plan?: string;
	email?: string;
	source: string;
}

interface CachedAuthEntry {
	accessToken?: string;
	expiresAt?: number;
	projectId?: string;
	plan?: string;
	email?: string;
	updatedAt: number;
}

interface DiskCredential {
	refreshToken: string;
	accessTokenHint?: string;
	expiresAtHint?: number;
	projectHint?: string;
	emailHint?: string;
	clientId: string;
	clientSecret: string;
	tokenUri: string;
	scopes: string[];
	filePath: string;
}

function getAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".gentle-shell", "agent");
}

function getCachePath(): string {
	return path.join(getAgentDir(), "antigravity-oauth-cache.json");
}

export function getTokenFilePath(providerId: AntigravityProviderId): string {
	const home = os.homedir();
	return providerId === "antigravity"
		? path.join(home, ".gemini", "antigravity-acp", "acp_token.json")
		: path.join(home, ".gemini", "antigravity-cli", "antigravity-oauth-token");
}

function fingerprint(secret: string): string {
	return crypto.createHash("sha256").update(secret).digest("hex").slice(0, 16);
}

function readJsonSafe(filePath: string): Record<string, unknown> | undefined {
	try {
		const raw = fs.readFileSync(filePath, "utf8");
		const parsed = JSON.parse(raw) as unknown;
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
	} catch {
		/* missing or unreadable */
	}
	return undefined;
}

function readCacheFile(): Record<string, CachedAuthEntry> {
	const raw = readJsonSafe(getCachePath());
	if (!raw) return {};
	const out: Record<string, CachedAuthEntry> = {};
	for (const [k, v] of Object.entries(raw)) {
		if (v && typeof v === "object" && !Array.isArray(v)) {
			out[k] = v as CachedAuthEntry;
		}
	}
	return out;
}

let memoryCache: Record<string, CachedAuthEntry> | undefined;

function getCacheEntry(key: string): CachedAuthEntry | undefined {
	if (!memoryCache) memoryCache = readCacheFile();
	return memoryCache[key];
}

function setCacheEntry(key: string, entry: CachedAuthEntry): void {
	if (!memoryCache) memoryCache = readCacheFile();
	memoryCache[key] = entry;
	const cachePath = getCachePath();
	try {
		fs.mkdirSync(path.dirname(cachePath), { recursive: true });
		const tmp = `${cachePath}.${process.pid}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify(memoryCache, null, 2) + "\n", { mode: 0o600 });
		fs.renameSync(tmp, cachePath);
	} catch {
		/* best-effort cache */
	}
}

function readOAuthClientDefaults(): {
	clientId: string;
	clientSecret: string;
	tokenUri: string;
	scopes: string[];
} {
	const acp = readJsonSafe(getTokenFilePath("antigravity"));
	const custom = readJsonSafe(path.join(getAgentDir(), "antigravity-oauth-client.json"));
	const clientId =
		process.env.ANTIGRAVITY_OAUTH_CLIENT_ID?.trim() ||
		(typeof acp?.client_id === "string" ? acp.client_id.trim() : "") ||
		(typeof custom?.client_id === "string" ? custom.client_id.trim() : "");
	const clientSecret =
		process.env.ANTIGRAVITY_OAUTH_CLIENT_SECRET?.trim() ||
		(typeof acp?.client_secret === "string" ? acp.client_secret.trim() : "") ||
		(typeof custom?.client_secret === "string" ? custom.client_secret.trim() : "");
	const tokenUri = typeof acp?.token_uri === "string" && acp.token_uri ? acp.token_uri : DEFAULT_TOKEN_URI;
	const scopes = Array.isArray(acp?.scopes)
		? acp.scopes.filter((s): s is string => typeof s === "string" && s.length > 0)
		: DEFAULT_SCOPES;
	return { clientId, clientSecret, tokenUri, scopes: scopes.length > 0 ? scopes : DEFAULT_SCOPES };
}

function assertOAuthClient(clientId: string, clientSecret: string): void {
	if (!clientId || !clientSecret) {
		throw new Error(
			"Missing Google OAuth client credentials. Set ANTIGRAVITY_OAUTH_CLIENT_ID and ANTIGRAVITY_OAUTH_CLIENT_SECRET, or configure ~/.gemini/antigravity-acp/acp_token.json or ~/.gentle-shell/agent/antigravity-oauth-client.json.",
		);
	}
}

export function readDiskCredential(providerId: AntigravityProviderId): DiskCredential | undefined {
	const filePath = getTokenFilePath(providerId);
	const raw = readJsonSafe(filePath);
	if (!raw) return undefined;
	const defaults = readOAuthClientDefaults();

	if (providerId === "antigravity") {
		const refreshToken = typeof raw.refresh_token === "string" ? raw.refresh_token.trim() : "";
		if (!refreshToken) return undefined;
		return {
			refreshToken,
			projectHint: typeof raw.project_id === "string" && raw.project_id ? raw.project_id : undefined,
			clientId: typeof raw.client_id === "string" && raw.client_id ? raw.client_id : defaults.clientId,
			clientSecret: typeof raw.client_secret === "string" && raw.client_secret ? raw.client_secret : defaults.clientSecret,
			tokenUri: typeof raw.token_uri === "string" && raw.token_uri ? raw.token_uri : defaults.tokenUri,
			scopes: defaults.scopes,
			filePath,
		};
	}

	const tokenObj =
		raw.token && typeof raw.token === "object" && !Array.isArray(raw.token)
			? (raw.token as Record<string, unknown>)
			: undefined;
	const refreshToken = typeof tokenObj?.refresh_token === "string" ? tokenObj.refresh_token.trim() : "";
	if (!refreshToken) return undefined;

	const accessTokenHint =
		typeof tokenObj?.access_token === "string" && tokenObj.access_token ? tokenObj.access_token : undefined;
	let expiresAtHint: number | undefined;
	if (typeof tokenObj?.expiry === "string") {
		const parsed = Date.parse(tokenObj.expiry);
		if (Number.isFinite(parsed)) expiresAtHint = parsed;
	}
	const emailHint = typeof raw.id_token_email === "string" && raw.id_token_email ? raw.id_token_email : undefined;

	return {
		refreshToken,
		accessTokenHint,
		expiresAtHint,
		emailHint,
		clientId: defaults.clientId,
		clientSecret: defaults.clientSecret,
		tokenUri: defaults.tokenUri,
		scopes: defaults.scopes,
		filePath,
	};
}

function readStoredGentleOAuth(providerId: AntigravityProviderId): {
	access?: string;
	refresh?: string;
	expires?: number;
	projectId?: string;
	email?: string;
} | undefined {
	const auth = readJsonSafe(path.join(getAgentDir(), "auth.json"));
	const cred = auth?.[providerId];
	if (!cred || typeof cred !== "object" || Array.isArray(cred)) return undefined;
	const obj = cred as Record<string, unknown>;
	if (obj.type !== "oauth") return undefined;
	return {
		access: typeof obj.access === "string" ? obj.access : undefined,
		refresh: typeof obj.refresh === "string" ? obj.refresh : undefined,
		expires: typeof obj.expires === "number" ? obj.expires : undefined,
		projectId: typeof obj.projectId === "string" ? obj.projectId : undefined,
		email: typeof obj.email === "string" ? obj.email : undefined,
	};
}

export function combineSignals(signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
	const active = signals.filter((s): s is AbortSignal => s !== undefined);
	if (active.length === 0) return undefined;
	if (active.length === 1) return active[0];
	return AbortSignal.any(active);
}

export async function fetchWithRetry(
	url: string,
	init: RequestInit,
	options: { timeoutMs?: number; signal?: AbortSignal; retries?: number } = {},
): Promise<Response> {
	const timeoutMs = options.timeoutMs ?? AUTH_FETCH_TIMEOUT_MS;
	const retries = options.retries ?? 1;
	let lastErr: unknown;
	for (let attempt = 0; attempt <= retries; attempt++) {
		options.signal?.throwIfAborted();
		const reqSignal = combineSignals([options.signal, AbortSignal.timeout(timeoutMs)]);
		try {
			return await fetch(url, { ...init, signal: reqSignal });
		} catch (err) {
			lastErr = err;
			if (options.signal?.aborted || attempt === retries) throw err;
			await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
		}
	}
	throw lastErr;
}

export function ccpaHeaders(accessToken: string): Record<string, string> {
	return {
		Authorization: `Bearer ${accessToken}`,
		"Content-Type": "application/json",
		"User-Agent": CCPA_USER_AGENT,
	};
}

export async function ccpaPostJson<T = Record<string, unknown>>(
	endpointPath: string,
	accessToken: string,
	body: unknown,
	options: { signal?: AbortSignal; fetchFn?: typeof fetch; timeoutMs?: number } = {},
): Promise<{ status: number; data?: T; errorText?: string }> {
	const fetchImpl = options.fetchFn ?? fetch;
	let lastStatus = 0;
	let lastErrorText = "";
	for (let i = 0; i < CCPA_BASE_URLS.length; i++) {
		const url = `${CCPA_BASE_URLS[i]}${endpointPath}`;
		options.signal?.throwIfAborted();
		const reqSignal = combineSignals([options.signal, AbortSignal.timeout(options.timeoutMs ?? AUTH_FETCH_TIMEOUT_MS)]);
		try {
			const res = await fetchImpl(url, {
				method: "POST",
				headers: ccpaHeaders(accessToken),
				body: JSON.stringify(body),
				signal: reqSignal,
			});
			lastStatus = res.status;
			if (res.ok) {
				const data = (await res.json()) as T;
				return { status: res.status, data };
			}
			lastErrorText = await res.text().catch(() => "");
			if (res.status === 401 || res.status === 403 || (res.status >= 400 && res.status < 500 && res.status !== 404)) {
				return { status: res.status, errorText: lastErrorText };
			}
		} catch (err) {
			if (options.signal?.aborted) throw err;
			lastErrorText = err instanceof Error ? err.message : String(err);
		}
	}
	return { status: lastStatus || 503, errorText: lastErrorText };
}

async function refreshGoogleOAuthToken(
	refreshToken: string,
	clientId: string,
	clientSecret: string,
	tokenUri: string,
	signal?: AbortSignal,
): Promise<{ accessToken: string; expiresAt: number }> {
	assertOAuthClient(clientId, clientSecret);
	const res = await fetchWithRetry(
		tokenUri,
		{
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				client_id: clientId,
				client_secret: clientSecret,
				refresh_token: refreshToken,
				grant_type: "refresh_token",
			}),
		},
		{ signal, retries: 2 },
	);
	if (!res.ok) {
		const detail = await res.text().catch(() => "");
		throw new Error(`OAuth token refresh failed (${res.status}): ${detail.slice(0, 240)}`);
	}
	const json = (await res.json()) as { access_token?: string; expires_in?: number };
	if (!json.access_token) {
		throw new Error("OAuth token refresh returned no access_token");
	}
	const expiresInSec = typeof json.expires_in === "number" && json.expires_in > 0 ? json.expires_in : 3600;
	return {
		accessToken: json.access_token,
		expiresAt: Date.now() + expiresInSec * 1000,
	};
}

async function fetchUserEmail(accessToken: string, signal?: AbortSignal): Promise<string | undefined> {
	try {
		const res = await fetchWithRetry(
			"https://www.googleapis.com/oauth2/v2/userinfo",
			{ headers: { Authorization: `Bearer ${accessToken}` } },
			{ signal, timeoutMs: 8_000, retries: 0 },
		);
		if (!res.ok) return undefined;
		const json = (await res.json()) as { email?: string };
		return typeof json.email === "string" && json.email ? json.email : undefined;
	} catch {
		return undefined;
	}
}

async function fetchProjectAndTier(
	accessToken: string,
	projectHint?: string,
	signal?: AbortSignal,
): Promise<{ projectId: string; plan?: string }> {
	const res = await ccpaPostJson<Record<string, unknown>>(
		"/v1internal:loadCodeAssist",
		accessToken,
		{
			metadata: {
				ideType: "IDE_UNSPECIFIED",
				platform: "PLATFORM_UNSPECIFIED",
				pluginType: "GEMINI",
			},
		},
		{ signal, timeoutMs: 12_000 },
	);
	if (res.data) {
		const rawProj = res.data.cloudaicompanionProject;
		let projectId = projectHint || DEFAULT_PROJECT_ID;
		if (typeof rawProj === "string" && rawProj) {
			projectId = rawProj;
		} else if (rawProj && typeof rawProj === "object" && typeof (rawProj as { id?: unknown }).id === "string") {
			projectId = (rawProj as { id: string }).id;
		}
		const paidTier = res.data.paidTier as { name?: string } | undefined;
		const currentTier = res.data.currentTier as { name?: string } | undefined;
		const plan =
			(typeof paidTier?.name === "string" && paidTier.name) ||
			(typeof currentTier?.name === "string" && currentTier.name) ||
			undefined;
		return { projectId, plan };
	}
	return { projectId: projectHint || DEFAULT_PROJECT_ID };
}

const inFlightAuth = new Map<string, Promise<ResolvedAccountAuth>>();

export function invalidateAccountCache(providerId: AntigravityProviderId): void {
	if (!memoryCache) memoryCache = readCacheFile();
	for (const key of Object.keys(memoryCache)) {
		if (key.startsWith(`${providerId}:`) || key.startsWith("token:")) {
			delete memoryCache[key];
		}
	}
}

export async function ensureAccountAuth(
	providerId: AntigravityProviderId,
	options: { forceRefresh?: boolean; apiKeyOverride?: string; signal?: AbortSignal } = {},
): Promise<ResolvedAccountAuth> {
	const now = Date.now();
	const signal = options.signal;

	if (options.apiKeyOverride) {
		const tokenKey = `token:${providerId}:${fingerprint(options.apiKeyOverride)}`;
		const cached = getCacheEntry(tokenKey);
		if (!options.forceRefresh && cached?.projectId) {
			return {
				providerId,
				accessToken: options.apiKeyOverride,
				expiresAt: cached.expiresAt ?? now + 30 * 60_000,
				projectId: cached.projectId,
				plan: cached.plan,
				email: cached.email,
				source: "provider-auth",
			};
		}
		const existing = inFlightAuth.get(tokenKey);
		if (existing && !options.forceRefresh) return existing;
		const promise = (async (): Promise<ResolvedAccountAuth> => {
			try {
				const disk = readDiskCredential(providerId);
				const [{ projectId, plan }, email] = await Promise.all([
					fetchProjectAndTier(options.apiKeyOverride!, disk?.projectHint, signal),
					disk?.emailHint ? Promise.resolve(disk.emailHint) : fetchUserEmail(options.apiKeyOverride!, signal),
				]);
				setCacheEntry(tokenKey, {
					projectId,
					plan,
					email,
					expiresAt: now + 30 * 60_000,
					updatedAt: Date.now(),
				});
				return {
					providerId,
					accessToken: options.apiKeyOverride!,
					expiresAt: now + 30 * 60_000,
					projectId,
					plan,
					email,
					source: "provider-auth",
				};
			} finally {
				inFlightAuth.delete(tokenKey);
			}
		})();
		inFlightAuth.set(tokenKey, promise);
		return promise;
	}

	const storedOAuth = readStoredGentleOAuth(providerId);
	const disk = readDiskCredential(providerId);
	const defaults = readOAuthClientDefaults();

	const refreshToken = storedOAuth?.refresh || disk?.refreshToken;
	if (!refreshToken) {
		throw new Error(
			providerId === "antigravity"
				? "Missing Antigravity (ACP) credentials (~/.gemini/antigravity-acp/acp_token.json). Run /login antigravity."
				: "Missing Antigravity (CLI) credentials (~/.gemini/antigravity-cli/antigravity-oauth-token). Run /login antigravity-cli.",
		);
	}

	const cacheKey = `${providerId}:${fingerprint(refreshToken)}`;
	const cached = getCacheEntry(cacheKey);
	if (
		!options.forceRefresh &&
		cached?.accessToken &&
		cached.expiresAt &&
		cached.expiresAt > now + EXPIRY_BUFFER_MS &&
		cached.projectId
	) {
		return {
			providerId,
			accessToken: cached.accessToken,
			expiresAt: cached.expiresAt,
			projectId: cached.projectId,
			plan: cached.plan,
			email: cached.email ?? storedOAuth?.email ?? disk?.emailHint,
			source: storedOAuth?.refresh ? "auth.json" : disk!.filePath,
		};
	}

	const inFlightKey = `${cacheKey}:${options.forceRefresh ? "force" : "norm"}`;
	const existing = inFlightAuth.get(inFlightKey);
	if (existing) return existing;

	const promise = (async (): Promise<ResolvedAccountAuth> => {
		try {
			let accessToken = !options.forceRefresh ? cached?.accessToken : undefined;
			let expiresAt = !options.forceRefresh ? cached?.expiresAt : undefined;

			if (!accessToken || !expiresAt || expiresAt <= Date.now() + EXPIRY_BUFFER_MS) {
				if (
					!options.forceRefresh &&
					storedOAuth?.access &&
					storedOAuth.expires &&
					storedOAuth.expires > Date.now() + EXPIRY_BUFFER_MS
				) {
					accessToken = storedOAuth.access;
					expiresAt = storedOAuth.expires;
				} else if (
					!options.forceRefresh &&
					!storedOAuth?.refresh &&
					disk?.accessTokenHint &&
					disk.expiresAtHint &&
					disk.expiresAtHint > Date.now() + EXPIRY_BUFFER_MS
				) {
					accessToken = disk.accessTokenHint;
					expiresAt = disk.expiresAtHint;
				} else {
					const refreshed = await refreshGoogleOAuthToken(
						refreshToken,
						disk?.clientId ?? defaults.clientId,
						disk?.clientSecret ?? defaults.clientSecret,
						disk?.tokenUri ?? defaults.tokenUri,
						signal,
					);
					accessToken = refreshed.accessToken;
					expiresAt = refreshed.expiresAt;
				}
			}

			let projectId = cached?.projectId ?? storedOAuth?.projectId ?? disk?.projectHint;
			let plan = cached?.plan;
			let email = cached?.email ?? storedOAuth?.email ?? disk?.emailHint;

			if (!projectId || !plan || !email) {
				const [projInfo, fetchedEmail] = await Promise.all([
					!projectId || !plan
						? fetchProjectAndTier(accessToken, projectId, signal)
						: Promise.resolve({ projectId, plan }),
					email ? Promise.resolve(email) : fetchUserEmail(accessToken, signal),
				]);
				projectId = projInfo.projectId;
				plan = projInfo.plan ?? plan;
				email = fetchedEmail ?? email;
			}

			setCacheEntry(cacheKey, {
				accessToken,
				expiresAt,
				projectId,
				plan,
				email,
				updatedAt: Date.now(),
			});

			return {
				providerId,
				accessToken,
				expiresAt,
				projectId,
				plan,
				email,
				source: storedOAuth?.refresh ? "auth.json" : disk!.filePath,
			};
		} finally {
			inFlightAuth.delete(inFlightKey);
		}
	})();

	inFlightAuth.set(inFlightKey, promise);
	return promise;
}

export function maskEmail(email?: string): string | undefined {
	if (!email) return undefined;
	const at = email.indexOf("@");
	if (at <= 0) return email;
	const local = email.slice(0, at);
	const domain = email.slice(at + 1);
	const keep = local.slice(0, Math.min(3, local.length));
	return `${keep}***@${domain}`;
}

function base64Url(buf: Buffer): string {
	return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function runGoogleOAuthLoopbackLogin(
	providerId: AntigravityProviderId,
	interaction: ProviderAuthInteraction,
): Promise<{
	type: "oauth";
	access: string;
	refresh: string;
	expires: number;
	projectId: string;
	email?: string;
}> {
	const { clientId, clientSecret, tokenUri, scopes } = readOAuthClientDefaults();
	assertOAuthClient(clientId, clientSecret);
	const verifier = base64Url(crypto.randomBytes(32));
	const challenge = base64Url(crypto.createHash("sha256").update(verifier).digest());
	const state = base64Url(crypto.randomBytes(16));

	let server: http.Server | undefined;
	let port = 0;

	const codePromise = new Promise<string>((resolve, reject) => {
		let settled = false;
		const finish = (err?: Error, code?: string) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			interaction.signal.removeEventListener("abort", onAbort);
			if (err) reject(err);
			else resolve(code!);
		};
		const onAbort = () => finish(new Error("OAuth login aborted"));
		interaction.signal.addEventListener("abort", onAbort, { once: true });

		const timer = setTimeout(() => {
			finish(new Error("OAuth login timed out after 5 minutes"));
		}, LOGIN_TIMEOUT_MS);

		server = http.createServer((req, res) => {
			try {
				const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
				if (url.pathname !== "/oauth2callback") {
					res.writeHead(404).end("Not found");
					return;
				}
				const errParam = url.searchParams.get("error");
				const returnedState = url.searchParams.get("state");
				const code = url.searchParams.get("code");
				if (errParam) {
					res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" }).end(
						`<h3>Antigravity OAuth Error</h3><p>${errParam}</p>`,
					);
					finish(new Error(`Google OAuth rejected: ${errParam}`));
					return;
				}
				if (returnedState !== state || !code) {
					res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" }).end(
						"<h3>Invalid OAuth callback state</h3>",
					);
					finish(new Error("Invalid OAuth state or missing authorization code"));
					return;
				}
				res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(
					"<h3>Autenticación completada</h3><p>Ya puedes cerrar esta pestaña y volver a Gentle Shell.</p>",
				);
				finish(undefined, code);
			} catch (e) {
				finish(e instanceof Error ? e : new Error(String(e)));
			}
		});

		server.on("error", (e) => finish(e));
		server.listen(0, "127.0.0.1", () => {
			const addr = server!.address();
			if (!addr || typeof addr === "string") {
				finish(new Error("Failed to bind OAuth callback server"));
				return;
			}
			port = addr.port;
			const redirectUri = `http://127.0.0.1:${port}/oauth2callback`;
			const authUrl = new URL(DEFAULT_AUTH_URI);
			authUrl.searchParams.set("client_id", clientId);
			authUrl.searchParams.set("redirect_uri", redirectUri);
			authUrl.searchParams.set("response_type", "code");
			authUrl.searchParams.set("scope", scopes.join(" "));
			authUrl.searchParams.set("access_type", "offline");
			authUrl.searchParams.set("prompt", "consent");
			authUrl.searchParams.set("code_challenge", challenge);
			authUrl.searchParams.set("code_challenge_method", "S256");
			authUrl.searchParams.set("state", state);

			const label = providerId === "antigravity" ? "Antigravity (ACP)" : "Antigravity (CLI)";
			interaction.notify({
				type: "auth_url",
				url: authUrl.toString(),
				instructions: `Inicia sesión en ${label} desde el navegador.`,
			});
			interaction.notify({
				type: "progress",
				message: "Esperando confirmación de Google en el navegador...",
			});
		});
	});

	try {
		const code = await codePromise;
		const redirectUri = `http://127.0.0.1:${port}/oauth2callback`;
		const tokenRes = await fetchWithRetry(
			tokenUri,
			{
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({
					client_id: clientId,
					client_secret: clientSecret,
					code,
					code_verifier: verifier,
					redirect_uri: redirectUri,
					grant_type: "authorization_code",
				}),
			},
			{ signal: interaction.signal, retries: 1 },
		);
		if (!tokenRes.ok) {
			const detail = await tokenRes.text().catch(() => "");
			throw new Error(`OAuth code exchange failed (${tokenRes.status}): ${detail.slice(0, 240)}`);
		}
		const tokenJson = (await tokenRes.json()) as {
			access_token?: string;
			refresh_token?: string;
			expires_in?: number;
		};
		if (!tokenJson.access_token || !tokenJson.refresh_token) {
			throw new Error("Google OAuth returned incomplete tokens (missing access_token or refresh_token)");
		}
		const expires = Date.now() + (tokenJson.expires_in ?? 3600) * 1000;
		const [{ projectId, plan }, email] = await Promise.all([
			fetchProjectAndTier(tokenJson.access_token, undefined, interaction.signal),
			fetchUserEmail(tokenJson.access_token, interaction.signal),
		]);
		setCacheEntry(`${providerId}:${fingerprint(tokenJson.refresh_token)}`, {
			accessToken: tokenJson.access_token,
			expiresAt: expires,
			projectId,
			plan,
			email,
			updatedAt: Date.now(),
		});
		return {
			type: "oauth",
			access: tokenJson.access_token,
			refresh: tokenJson.refresh_token,
			expires,
			projectId,
			email,
		};
	} finally {
		server?.close();
	}
}

export function buildProviderAuth(providerId: AntigravityProviderId) {
	const label = providerId === "antigravity" ? "Google Antigravity (ACP)" : "Google Antigravity (CLI)";
	const diskPath = getTokenFilePath(providerId);

	return {
		oauth: {
			name: label,
			isSubscription: true,
			async login(interaction: ProviderAuthInteraction) {
				return runGoogleOAuthLoopbackLogin(providerId, interaction);
			},
			async refresh(
				credential: {
					type: "oauth";
					access: string;
					refresh: string;
					expires: number;
					projectId?: string;
					email?: string;
				},
				signal?: AbortSignal,
			) {
				const { clientId, clientSecret, tokenUri } = readOAuthClientDefaults();
				const refreshed = await refreshGoogleOAuthToken(
					credential.refresh,
					clientId,
					clientSecret,
					tokenUri,
					signal,
				);
				const [{ projectId, plan }, email] = await Promise.all([
					credential.projectId
						? Promise.resolve({ projectId: credential.projectId, plan: undefined })
						: fetchProjectAndTier(refreshed.accessToken, undefined, signal),
					credential.email ? Promise.resolve(credential.email) : fetchUserEmail(refreshed.accessToken, signal),
				]);
				setCacheEntry(`${providerId}:${fingerprint(credential.refresh)}`, {
					accessToken: refreshed.accessToken,
					expiresAt: refreshed.expiresAt,
					projectId,
					plan,
					email,
					updatedAt: Date.now(),
				});
				return {
					...credential,
					access: refreshed.accessToken,
					expires: refreshed.expiresAt,
					projectId,
					email,
				};
			},
			async toAuth(credential: { access: string }) {
				return { apiKey: credential.access };
			},
		},
		apiKey: {
			name: `${label} token (${diskPath})`,
			async check() {
				const disk = readDiskCredential(providerId);
				return disk ? { source: disk.filePath, type: "api_key" as const } : undefined;
			},
			async resolve({ signal }: { signal: AbortSignal }) {
				const disk = readDiskCredential(providerId);
				if (!disk) return undefined;
				const resolved = await ensureAccountAuth(providerId, { signal });
				return {
					auth: { apiKey: resolved.accessToken },
					source: resolved.source,
				};
			},
		},
	};
}
