import type { Api, Model, ThinkingLevel, ThinkingLevelMap } from "@earendil-works/pi-ai";
import { CCPA_BASE_URLS, type AntigravityProviderId } from "./ccpa-auth.js";

export const CCPA_API_ID = "ccpa-gemini" as Api;

interface GeminiFamilySpec {
	id: string;
	name: string;
	contextWindow: number;
	maxTokens: number;
	efforts: readonly ("low" | "medium" | "high" | "xhigh")[];
	thinkingLevelMap: ThinkingLevelMap;
}

const GEMINI_FAMILIES: readonly GeminiFamilySpec[] = [
	{
		id: "gemini-4-hydrogen",
		name: "Gemini 4 Hydrogen",
		contextWindow: 1_048_576,
		maxTokens: 262_144,
		efforts: ["low", "medium", "high", "xhigh"],
		thinkingLevelMap: { off: null, minimal: null, xhigh: "xhigh" } as ThinkingLevelMap,
	},
	{
		id: "gemini-4-argon",
		name: "Gemini 4 Argon",
		contextWindow: 1_048_576,
		maxTokens: 65_536,
		efforts: ["low", "medium", "high"],
		thinkingLevelMap: { off: null, minimal: null } as ThinkingLevelMap,
	},
	{
		id: "gemini-3.8-flash",
		name: "Gemini 3.8 Flash",
		contextWindow: 1_048_576,
		maxTokens: 65_536,
		efforts: ["low", "medium", "high"],
		thinkingLevelMap: { off: null, minimal: null } as ThinkingLevelMap,
	},
];

export function buildGeminiModels(providerId: AntigravityProviderId): Model<Api>[] {
	return GEMINI_FAMILIES.map((spec) => ({
		id: spec.id,
		name: spec.name,
		api: CCPA_API_ID,
		provider: providerId,
		baseUrl: CCPA_BASE_URLS[0],
		reasoning: true,
		thinkingLevelMap: spec.thinkingLevelMap,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: spec.contextWindow,
		maxTokens: spec.maxTokens,
	}));
}

const TIER_SUFFIX_RE = /^(.+)-(low|medium|high|xhigh)$/;

export function normalizeBaseModelId(rawModelId: string): string {
	let id = rawModelId.trim();
	if (id.endsWith("-acp")) id = id.slice(0, -4);
	else if (id.endsWith("-cli")) id = id.slice(0, -4);
	if (id.startsWith("gemini-3-8-flash")) {
		id = "gemini-3.8-flash" + id.slice("gemini-3-8-flash".length);
	}
	return id;
}

export function resolveRemoteModelId(rawModelId: string, reasoning?: ThinkingLevel): string {
	const normalized = normalizeBaseModelId(rawModelId);
	const explicitTierMatch = TIER_SUFFIX_RE.exec(normalized);
	if (explicitTierMatch) {
		return normalized;
	}

	const spec = GEMINI_FAMILIES.find((f) => f.id === normalized);
	if (!spec) {
		return normalized;
	}

	let tier: "low" | "medium" | "high" | "xhigh" = "medium";
	switch (reasoning) {
		case "minimal":
		case "low":
			tier = "low";
			break;
		case "medium":
			tier = "medium";
			break;
		case "high":
			tier = "high";
			break;
		case "xhigh":
		case "max":
			tier = spec.efforts.includes("xhigh") ? "xhigh" : "high";
			break;
		default:
			tier = "medium";
			break;
	}

	if (!spec.efforts.includes(tier)) {
		tier = spec.efforts[0] ?? "low";
	}
	return `${spec.id}-${tier}`;
}
