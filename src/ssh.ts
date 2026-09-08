export const DEFAULT_TIMEOUT_SECONDS = 30;

const FORWARDED_PI_ENV = new Set([
	"PI_SESSION_ID",
	"PI_SESSION_FILE",
	"PI_PROVIDER",
	"PI_MODEL",
	"PI_REASONING_LEVEL",
]);

export interface TargetSpec {
	target: string;
	cwd?: string;
}

/** Quote one POSIX shell word without allowing interpolation. */
export function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function validateTarget(target: string): void {
	if (!target) throw new Error("SSH target cannot be empty");
	if (target.startsWith("-")) throw new Error("SSH target cannot start with '-'");
	if (/\s/.test(target)) {
		throw new Error("SSH target cannot contain whitespace; configure complex options in ~/.ssh/config");
	}
}

/**
 * Accept TARGET, TARGET:/absolute/path, TARGET:~/path, or TARGET /path.
 * Non-standard ports and ProxyJump belong in ~/.ssh/config.
 */
export function parseTargetSpec(input: string): TargetSpec {
	const spec = input.trim();
	if (!spec) throw new Error("Usage: /ssh user@host[:/remote/path]");

	// Parse the colon form first so paths containing spaces remain intact.
	// The greedy target match preserves bracketed IPv6 addresses and splits
	// only on a colon that introduces an absolute or home-relative path.
	const pathMatch = /^(.*):((?:\/|~(?:\/|$)).*)$/.exec(spec);
	if (pathMatch) {
		const target = pathMatch[1];
		validateTarget(target);
		return { target, cwd: pathMatch[2] };
	}

	const whitespace = spec.search(/\s/);
	if (whitespace > 0) {
		const target = spec.slice(0, whitespace);
		const cwd = spec.slice(whitespace).trim();
		validateTarget(target);
		return { target, cwd: cwd || undefined };
	}

	validateTarget(spec);
	return { target: spec, cwd: undefined };
}

export function changeDirectoryCommand(cwd: string): string {
	if (cwd === "~") return `cd -- "$HOME"`;
	if (cwd.startsWith("~/")) return `cd -- "$HOME"/${shellQuote(cwd.slice(2))}`;
	return `cd -- ${shellQuote(cwd)}`;
}

/**
 * Build the single command argument passed to OpenSSH. The actual Bash
 * program is base64-encoded so the remote account's login shell never needs
 * to parse the user's quotes, heredocs, substitutions, or newlines.
 */
export function remoteScript(
	command: string,
	cwd?: string,
	environment: Record<string, string | undefined> = {},
): string {
	const exports = Object.entries(environment)
		.filter(([key, value]) => FORWARDED_PI_ENV.has(key) && value !== undefined)
		.map(([key, value]) => `export ${key}=${shellQuote(value!)}`);
	const lines = [...exports, ...(cwd ? [`${changeDirectoryCommand(cwd)} || exit $?`] : []), command];
	const payload = Buffer.from(lines.join("\n"), "utf8").toString("base64");
	return `printf '%s' '${payload}' | base64 -d | bash -s`;
}
