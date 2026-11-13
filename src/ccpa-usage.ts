import {
	CCPA_BASE_URLS,
	ccpaHeaders,
	combineSignals,
	ensureAccountAuth,
	maskEmail,
	readDiskCredential,
	type AntigravityProviderId,
	type ResolvedAccountAuth,
} from "./ccpa-auth.js";

export const USAGE_SOURCE_EVENT = "gentle-pi:usage-source/v1";
export const USAGE_SOURCE_SCHEMA = "gentle-pi.usage-source/v1";

export interface UsageWindow {
	label: string;
	usedPercent: number;
	windowSeconds: number;
	resetAt: number | null;
}

export interface UsageLimit {
	name: string;
	windows: UsageWindow[];
	limitReached: boolean;
}

export interface ProviderUsage {
	provider: string;
	plan: string | undefined;
	limits: UsageLimit[];
	fetchedAt: number;
}

export interface UsageSource {
	schema: typeof USAGE_SOURCE_SCHEMA;
	provider: string;
	pendingNote?: string;
	fetch(apiKey: string | undefined, fetchFn: typeof fetch, now: number): Promise<ProviderUsage | undefined>;
}

interface RawBucket {
	bucketId?: string;
	displayName?: string;
	window?: string;
	resetTime?: string;
	description?: string;
	remainingFraction?: number;
	remaining_fraction?: number;
	disabled?: boolean;
}

interface RawGroup {
	displayName?: string;
	name?: string;
	description?: string;
	buckets?: RawBucket[];
}

interface RawQuotaResponse {
	groups?: RawGroup[];
	description?: string;
}

export interface AccountQuotaSnapshot {
	providerId: AntigravityProviderId;
	label: string;
	configured: boolean;
	email?: string;
	plan?: string;
	groups: Array<{
		name: string;
		description?: string;
		buckets: Array<{
			bucketId?: string;
			displayName: string;
			window: string;
			remainingFraction: number;
			resetTime?: string;
			disabled: boolean;
		}>;
	}>;
	fetchedAt: number;
	error?: string;
}

const EXCLUDED_GROUP_RE = /claude|gpt|openai|anthropic|\b3p\b/i;

function clamp01(n: number): number {
	return Math.max(0, Math.min(1, n));
}

function isAllowedGroup(group: RawGroup): boolean {
	const name = (group.displayName ?? group.name ?? "").trim();
	if (EXCLUDED_GROUP_RE.test(name)) return false;
	const desc = (group.description ?? "").trim();
	if (EXCLUDED_GROUP_RE.test(desc)) return false;
	const buckets = group.buckets ?? [];
	if (buckets.length > 0 && buckets.every((b) => (b.bucketId ?? "").toLowerCase().startsWith("3p-"))) {
		return false;
	}
	return true;
}

function isAllowedBucket(bucket: RawBucket): boolean {
	const id = (bucket.bucketId ?? "").toLowerCase();
	if (id.startsWith("3p-")) return false;
	const name = (bucket.displayName ?? "").trim();
	if (EXCLUDED_GROUP_RE.test(name)) return false;
	return true;
}

const WINDOW_ORDER: Record<string, number> = { "5h": 0, weekly: 1 };

function parseFilteredGroups(raw: RawQuotaResponse): AccountQuotaSnapshot["groups"] {
	const out: AccountQuotaSnapshot["groups"] = [];
	for (const group of raw.groups ?? []) {
		if (!isAllowedGroup(group)) continue;
		const groupName = (group.displayName ?? group.name ?? "Gemini").trim();
		const buckets: AccountQuotaSnapshot["groups"][number]["buckets"] = [];
		for (const b of group.buckets ?? []) {
			if (!isAllowedBucket(b)) continue;
			const rawFrac =
				typeof b.remainingFraction === "number"
					? b.remainingFraction
					: typeof b.remaining_fraction === "number"
						? b.remaining_fraction
						: undefined;
			if (rawFrac === undefined || !Number.isFinite(rawFrac)) continue;
			buckets.push({
				bucketId: b.bucketId,
				displayName: b.displayName || b.bucketId || b.window || "Limit",
				window: (b.window || "unknown").toLowerCase(),
				remainingFraction: clamp01(rawFrac),
				resetTime: b.resetTime,
				disabled: b.disabled === true,
			});
		}
		if (buckets.length === 0) continue;
		buckets.sort((a, b) => (WINDOW_ORDER[a.window] ?? 9) - (WINDOW_ORDER[b.window] ?? 9));
		out.push({
			name: groupName,
			description: group.description,
			buckets,
		});
	}
	return out;
}

async function queryQuotaSummary(
	providerId: AntigravityProviderId,
	options: { apiKeyOverride?: string; fetchFn?: typeof fetch; signal?: AbortSignal } = {},
): Promise<{ auth: ResolvedAccountAuth; groups: AccountQuotaSnapshot["groups"] }> {
	const fetchImpl = options.fetchFn ?? fetch;
	let auth = await ensureAccountAuth(providerId, {
		apiKeyOverride: options.apiKeyOverride,
		signal: options.signal,
	});

	let retriedAuth = false;
	let lastStatus = 0;
	let lastError = "";

	for (let baseIdx = 0; baseIdx < CCPA_BASE_URLS.length; baseIdx++) {
		const url = `${CCPA_BASE_URLS[baseIdx]}/v1internal:retrieveUserQuotaSummary`;
		options.signal?.throwIfAborted();
		const reqSignal = combineSignals([options.signal, AbortSignal.timeout(12_000)]);
		try {
			const res = await fetchImpl(url, {
				method: "POST",
				headers: ccpaHeaders(auth.accessToken),
				body: JSON.stringify({ project: auth.projectId }),
				signal: reqSignal,
			});

			if (res.ok) {
				const raw = (await res.json()) as RawQuotaResponse;
				return { auth, groups: parseFilteredGroups(raw) };
			}

			lastStatus = res.status;
			lastError = await res.text().catch(() => "");

			if (res.status === 401 && !retriedAuth) {
				retriedAuth = true;
				auth = await ensureAccountAuth(providerId, { forceRefresh: true, signal: options.signal });
				baseIdx = -1;
				continue;
			}
			if (res.status >= 400 && res.status < 500 && res.status !== 404) {
				throw new Error(`HTTP ${res.status}: ${lastError.slice(0, 180)}`);
			}
		} catch (err) {
			if (options.signal?.aborted) throw err;
			lastError = err instanceof Error ? err.message : String(err);
		}
	}

	throw new Error(`Quota fetch failed (${lastStatus || "network"}): ${lastError.slice(0, 180)}`);
}

function windowSecondsFor(windowName: string): number {
	if (windowName === "5h") return 18_000;
	if (windowName === "weekly" || windowName === "7d") return 604_800;
	return 86_400;
}

function windowLabelFor(windowName: string): string {
	if (windowName === "5h") return "5h";
	if (windowName === "weekly") return "7d";
	return windowName;
}

export function createAntigravityUsageSource(providerId: AntigravityProviderId): UsageSource {
	return {
		schema: USAGE_SOURCE_SCHEMA,
		provider: providerId,
		pendingNote: "checking Antigravity Gemini quota…",
		async fetch(apiKey: string | undefined, fetchFn: typeof fetch, now: number): Promise<ProviderUsage | undefined> {
			try {
				if (!apiKey && !readDiskCredential(providerId)) {
					// Still allow stored auth.json via ensureAccountAuth; only skip if completely missing.
					try {
						await ensureAccountAuth(providerId);
					} catch {
						return undefined;
					}
				}
				const { auth, groups } = await queryQuotaSummary(providerId, {
					apiKeyOverride: apiKey,
					fetchFn,
				});
				const limits: UsageLimit[] = groups.map((group) => {
					const windows: UsageWindow[] = group.buckets.map((b) => {
						const parsedReset = b.resetTime ? Date.parse(b.resetTime) : Number.NaN;
						const usedPercent = Number(((1 - b.remainingFraction) * 100).toFixed(2));
						return {
							label: windowLabelFor(b.window),
							usedPercent,
							windowSeconds: windowSecondsFor(b.window),
							resetAt: Number.isFinite(parsedReset) ? parsedReset : null,
						};
					});
					return {
						name: group.name,
						windows,
						limitReached: group.buckets.some((b) => b.disabled || b.remainingFraction <= 0),
					};
				});
				const masked = maskEmail(auth.email);
				const plan = auth.plan && masked ? `${auth.plan} · ${masked}` : (auth.plan ?? masked);
				return {
					provider: providerId,
					plan,
					limits,
					fetchedAt: now,
				};
			} catch {
				return undefined;
			}
		},
	};
}

export async function fetchAccountSnapshot(providerId: AntigravityProviderId): Promise<AccountQuotaSnapshot> {
	const label = providerId === "antigravity" ? "Antigravity (ACP)" : "Antigravity (CLI)";
	const now = Date.now();
	try {
		const { auth, groups } = await queryQuotaSummary(providerId);
		return {
			providerId,
			label,
			configured: true,
			email: auth.email,
			plan: auth.plan,
			groups,
			fetchedAt: now,
		};
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		const missing = msg.includes("Missing Antigravity");
		return {
			providerId,
			label,
			configured: !missing,
			groups: [],
			fetchedAt: now,
			error: msg,
		};
	}
}

function quotaBar(remainingFraction: number): string {
	const filled = Math.round(clamp01(remainingFraction) * 20);
	return `${"█".repeat(filled)}${"░".repeat(20 - filled)}`;
}

function formatCountdown(ms: number): string {
	if (ms <= 0) return "ahora";
	const totalMins = Math.floor(ms / 60_000);
	const days = Math.floor(totalMins / (60 * 24));
	const hours = Math.floor((totalMins % (60 * 24)) / 60);
	const mins = totalMins % 60;
	if (days > 0) return `${days}d ${hours}h`;
	if (hours > 0) return `${hours}h ${mins}m`;
	return `${Math.max(1, mins)}m`;
}

function formatReset(resetTime: string | undefined, nowMs: number): string {
	if (!resetTime) return "";
	const at = new Date(resetTime);
	if (Number.isNaN(at.getTime())) return "";
	const now = new Date(nowMs);
	const hhmm = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
	const sameDay =
		at.getFullYear() === now.getFullYear() &&
		at.getMonth() === now.getMonth() &&
		at.getDate() === now.getDate();
	const clock = sameDay
		? `resets ${hhmm}`
		: `resets ${hhmm} on ${at.getDate()} ${at.toLocaleString("en", { month: "short" })}`;
	return ` · ${clock} (en ${formatCountdown(at.getTime() - nowMs)})`;
}

export async function fetchAndFormatDualUsage(activeProvider?: string): Promise<string> {
	const [acp, cli] = await Promise.all([
		fetchAccountSnapshot("antigravity"),
		fetchAccountSnapshot("antigravity-cli"),
	]);

	const snapshots = [acp, cli];
	const lines: string[] = ["Uso de cuentas Antigravity (solo Gemini; Claude/GPT excluidos)"];

	for (const snap of snapshots) {
		const isActive = activeProvider === snap.providerId ? " [ACTIVA]" : "";
		const metaParts = [snap.providerId, snap.plan, snap.email ? maskEmail(snap.email) : undefined].filter(
			(x): x is string => Boolean(x),
		);
		lines.push("", `${snap.label}${isActive} (${metaParts.join(" · ")})`);

		if (!snap.configured) {
			lines.push(`  No configurada. Ejecuta /login ${snap.providerId}`);
			continue;
		}
		if (snap.error) {
			lines.push(`  Error al consultar cuota: ${snap.error}`);
			continue;
		}
		if (snap.groups.length === 0) {
			lines.push("  Sin grupos Gemini disponibles.");
			continue;
		}

		for (const group of snap.groups) {
			lines.push(`  ${group.name}`);
			for (const b of group.buckets) {
				const winTag = b.window === "5h" ? "5h limit    " : b.window === "weekly" ? "Weekly limit" : `${b.window.padEnd(12)}`;
				if (b.disabled) {
					lines.push(`    ${winTag}: [agotado]${formatReset(b.resetTime, snap.fetchedAt)}`);
					continue;
				}
				const remPct = (b.remainingFraction * 100).toFixed(1).padStart(5);
				lines.push(
					`    ${winTag}: ${quotaBar(b.remainingFraction)} ${remPct}% left${formatReset(b.resetTime, snap.fetchedAt)}`,
				);
			}
		}
	}

	if (acp.email && cli.email && acp.email.toLowerCase() === cli.email.toLowerCase()) {
		lines.push(
			"",
			`Nota: ambas credenciales (${maskEmail(acp.email)}) apuntan actualmente a la misma cuenta Google. Puedes vincular otra cuenta con /login antigravity o /login antigravity-cli.`,
		);
	}

	return lines.join("\n");
}
