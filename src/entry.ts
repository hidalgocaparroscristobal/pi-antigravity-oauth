import { createProvider, registerApiProvider } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	buildProviderAuth,
	ensureAccountAuth,
	maskEmail,
	readDiskCredential,
	type AntigravityProviderId,
} from "./ccpa-auth.js";
import { buildGeminiModels, CCPA_API_ID } from "./ccpa-models.js";
import { streamCcpaGemini } from "./ccpa-stream.js";
import {
	createAntigravityUsageSource,
	fetchAndFormatDualUsage,
	USAGE_SOURCE_EVENT,
} from "./ccpa-usage.js";

function createAntigravityProvider(providerId: AntigravityProviderId) {
	const isAcp = providerId === "antigravity";
	return createProvider({
		id: providerId,
		name: isAcp ? "Antigravity (ACP)" : "Antigravity (CLI)",
		baseUrl: "https://daily-cloudcode-pa.googleapis.com",
		auth: buildProviderAuth(providerId),
		models: buildGeminiModels(providerId),
		api: {
			stream: streamCcpaGemini,
			streamSimple: streamCcpaGemini,
		},
	});
}

async function formatStatusReport(activeProvider?: string): Promise<string> {
	const ids: AntigravityProviderId[] = ["antigravity", "antigravity-cli"];
	const lines: string[] = [
		"Antigravity Direct OAuth (Gemini-only, sin subprocesos agy)",
		"  Modelos: gemini-4-hydrogen, gemini-4-argon, gemini-3.8-flash",
		"  Uso/Cuota: Alt+U o /usage",
		"",
	];

	for (const id of ids) {
		const label = id === "antigravity" ? "ACP (antigravity)" : "CLI (antigravity-cli)";
		const active = activeProvider === id ? " [ACTIVA]" : "";
		const disk = readDiskCredential(id);
		try {
			const auth = await ensureAccountAuth(id);
			const who = maskEmail(auth.email) || "cuenta verificada";
			const plan = auth.plan || "Google AI";
			lines.push(`  • ${label}${active}: OK · ${who} · ${plan} · proyecto=${auth.projectId}`);
		} catch (err) {
			const detail = disk ? `error al refrescar: ${err instanceof Error ? err.message : String(err)}` : "sin credenciales; usa /login " + id;
			lines.push(`  • ${label}${active}: ${detail}`);
		}
	}

	return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
	registerApiProvider({
		api: CCPA_API_ID,
		stream: streamCcpaGemini,
		streamSimple: streamCcpaGemini,
	});

	pi.registerProvider(createAntigravityProvider("antigravity"));
	pi.registerProvider(createAntigravityProvider("antigravity-cli"));

	const publishUsageSources = () => {
		pi.events.emit(USAGE_SOURCE_EVENT, createAntigravityUsageSource("antigravity"));
		pi.events.emit(USAGE_SOURCE_EVENT, createAntigravityUsageSource("antigravity-cli"));
	};

	publishUsageSources();
	pi.on("session_start", async () => {
		publishUsageSources();
	});

	async function runUsageCommand(ctx: Parameters<Parameters<ExtensionAPI["registerCommand"]>[1]["handler"]>[1]) {
		ctx.ui?.setStatus("antigravity-usage", "Consultando cuota Antigravity…");
		try {
			const report = await fetchAndFormatDualUsage(ctx.model?.provider);
			ctx.ui?.notify(report, "info");
		} catch (err) {
			ctx.ui?.notify(
				`Error al consultar /usage: ${err instanceof Error ? err.message : String(err)}`,
				"error",
			);
		} finally {
			ctx.ui?.setStatus("antigravity-usage", undefined);
		}
	}

	pi.registerCommand("usage", {
		description: "Muestra la cuota Gemini de ambas cuentas Antigravity (ACP y CLI)",
		handler: async (_args, ctx) => {
			await runUsageCommand(ctx);
		},
	});

	pi.registerCommand("agy", {
		description: "Estado y cuota de Antigravity Direct OAuth (/agy usage | /agy status)",
		handler: async (args, ctx) => {
			const sub = (args ?? "").trim().toLowerCase();
			if (sub === "usage" || sub === "quota") {
				await runUsageCommand(ctx);
				return;
			}
			const status = await formatStatusReport(ctx.model?.provider);
			ctx.ui?.notify(status, "info");
		},
	});
}
