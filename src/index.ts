import { spawn } from "node:child_process";
import type { BashOperations, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createBashTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { DEFAULT_TIMEOUT_SECONDS, parseTargetSpec, remoteScript, validateTarget } from "./ssh.ts";

const CONNECT_TIMEOUT_MS = 15_000;
const SSH_CONNECT_TIMEOUT_SECONDS = 10;

function sshArguments(target: string, script: string): string[] {
	return [
		"-T",
		"-o",
		"BatchMode=yes",
		"-o",
		`ConnectTimeout=${SSH_CONNECT_TIMEOUT_SECONDS}`,
		target,
		script,
	];
}

interface SelectedTarget {
	target: string;
	cwd: string;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export default function remoteBashExtension(pi: ExtensionAPI) {
	const localCwd = process.cwd();
	let selected: SelectedTarget | null = null;

	function notify(ctx: ExtensionContext, message: string, type: "info" | "error" = "info"): void {
		if (ctx.hasUI) ctx.ui.notify(message, type);
		else (type === "error" ? console.error : console.log)(`[ssh] ${message}`);
	}

	function updateStatus(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus("ssh", selected ? `SSH: ${selected.target}:${selected.cwd}` : undefined);
	}

	function sessionEnvironment(ctx: ExtensionContext): NodeJS.ProcessEnv {
		const environment: NodeJS.ProcessEnv = {
			PI_SESSION_ID: ctx.sessionManager.getSessionId(),
			PI_PROVIDER: ctx.model?.provider,
			PI_MODEL: ctx.model?.id,
			PI_REASONING_LEVEL: ctx.thinkingLevel,
		};
		const sessionFile = ctx.sessionManager.getSessionFile();
		if (sessionFile) environment.PI_SESSION_FILE = sessionFile;
		return environment;
	}

	function makeRemoteOperations(target: string, cwd: string | undefined, piEnvironment: NodeJS.ProcessEnv): BashOperations {
		return {
			exec: (command, _cwd, { onData, signal, timeout }) =>
				new Promise((resolve, reject) => {
					if (signal?.aborted) {
						reject(new Error("aborted"));
						return;
					}

					// Forward only the documented session metadata assembled above;
					// never leak arbitrary local PI_* environment variables.
					const child = spawn("ssh", sshArguments(target, remoteScript(command, cwd, piEnvironment)), {
						stdio: ["ignore", "pipe", "pipe"],
					});

					let settled = false;
					let timedOut = false;
					let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
					const timeoutSeconds = timeout ?? DEFAULT_TIMEOUT_SECONDS;
					const terminate = () => {
						child.kill("SIGTERM");
						forceKillTimer ??= setTimeout(() => child.kill("SIGKILL"), 1_000);
					};
					const timer = setTimeout(() => {
						timedOut = true;
						terminate();
					}, timeoutSeconds * 1000);
					const abort = terminate;

					const cleanup = () => {
						clearTimeout(timer);
						if (forceKillTimer) clearTimeout(forceKillTimer);
						signal?.removeEventListener("abort", abort);
					};
					const finish = (callback: () => void) => {
						if (settled) return;
						settled = true;
						cleanup();
						callback();
					};

					child.stdout?.on("data", onData);
					child.stderr?.on("data", onData);
					signal?.addEventListener("abort", abort, { once: true });
					child.on("error", (error) => finish(() => reject(error)));
					child.on("close", (code) => {
						finish(() => {
							if (signal?.aborted) reject(new Error("aborted"));
							else if (timedOut) reject(new Error(`timeout:${timeoutSeconds}`));
							else resolve({ exitCode: code });
						});
					});
				}),
		};
	}

	async function selectTarget(spec: string, ctx: ExtensionContext): Promise<void> {
		const parsed = parseTargetSpec(spec);
		const result = await pi.exec(
			"ssh",
			sshArguments(parsed.target, remoteScript("pwd -P", parsed.cwd)),
			{ signal: ctx.signal, timeout: CONNECT_TIMEOUT_MS },
		);
		if (result.code !== 0) {
			const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`;
			if (result.code === 255) throw new Error(`cannot connect to ${parsed.target}: ${detail}`);
			if (parsed.cwd) throw new Error(`connected to ${parsed.target}, but cannot use cwd ${parsed.cwd}: ${detail}`);
			throw new Error(`connected to ${parsed.target}, but the remote probe failed: ${detail}`);
		}
		const cwd = result.stdout.trim().split("\n").at(-1);
		if (!cwd) throw new Error(`could not determine the working directory on ${parsed.target}`);
		selected = { target: parsed.target, cwd };
		updateStatus(ctx);
		notify(ctx, `Selected ${selected.target}:${selected.cwd} for remote_bash.`);
	}

	pi.registerTool({
		name: "remote_bash",
		label: "Remote Bash",
		description:
			"Execute a non-interactive Bash command over SSH. Uses the target selected by /ssh unless target is supplied for a one-off command. The system OpenSSH client honors ~/.ssh/config, ssh-agent, ProxyJump, aliases, and ControlMaster settings. Output streams while running and is truncated using Pi's built-in bash limits. Local Pi tools remain local.",
		promptSnippet: "Execute non-interactive Bash commands on an SSH host without changing local Pi tools",
		promptGuidelines: [
			"Use remote_bash instead of wrapping ssh manually in local bash when the user asks to run commands on another machine.",
			"When /ssh has selected a target, omit remote_bash target and cwd unless a one-command override is needed.",
			"Local read, write, edit, and bash remain local even when an SSH target is selected; use remote_bash with bounded cat, sed, rg, or similar commands for remote files.",
			"Use nohup with explicit output redirection for remote jobs that must continue after remote_bash returns.",
		],
		parameters: Type.Object({
			command: Type.String({ description: "Bash command to execute on the remote host" }),
			target: Type.Optional(Type.String({ description: "One-off SSH target such as user@host or an alias from ~/.ssh/config" })),
			cwd: Type.Optional(Type.String({ description: "One-command remote working-directory override" })),
			timeout: Type.Optional(
				Type.Number({ minimum: 1, maximum: 3600, description: `Timeout in seconds; defaults to ${DEFAULT_TIMEOUT_SECONDS}` }),
			),
		}),
		async execute(id, params, signal, onUpdate, ctx) {
			const target = params.target?.trim() || selected?.target;
			if (!target) throw new Error("No SSH target selected. Use /ssh user@host or provide remote_bash target.");
			validateTarget(target);

			const cwd = params.cwd?.trim() || (selected?.target === target ? selected.cwd : undefined);
			const bash = createBashTool(localCwd, { operations: makeRemoteOperations(target, cwd, sessionEnvironment(ctx)) });
			return bash.execute(
				id,
				{ command: params.command, timeout: params.timeout ?? DEFAULT_TIMEOUT_SECONDS },
				signal,
				onUpdate,
			);
		},
	});

	pi.registerCommand("ssh", {
		description: "Select an SSH target for remote_bash: /ssh user@host[:/remote/path]",
		handler: async (args, ctx) => {
			const spec = (args ?? "").trim();
			if (!spec) {
				notify(
					ctx,
					selected
						? `Selected SSH target: ${selected.target}:${selected.cwd}`
						: "No SSH target selected. Usage: /ssh user@host[:/remote/path]",
				);
				return;
			}
			if (spec.toLowerCase() === "off") {
				selected = null;
				updateStatus(ctx);
				notify(ctx, "Cleared the SSH target; all Pi tools remain local.");
				return;
			}
			try {
				await selectTarget(spec, ctx);
			} catch (error) {
				notify(ctx, `SSH selection failed: ${errorText(error)}`, "error");
			}
		},
	});

	pi.registerCommand("local", {
		description: "Clear the selected remote_bash target",
		handler: async (_args, ctx) => {
			selected = null;
			updateStatus(ctx);
			notify(ctx, "Cleared the SSH target; all Pi tools remain local.");
		},
	});

	pi.on("before_agent_start", (event) => {
		if (!selected) return;
		return {
			systemPrompt:
				event.systemPrompt +
				`\n\nRemote command target selected: ${selected.target}, working directory ${selected.cwd}. ` +
				"Use remote_bash for commands on that machine. All ordinary read, write, edit, bash, grep, find, and ls tools still operate locally.",
		};
	});

	pi.on("session_shutdown", async () => {
		selected = null;
	});
}
