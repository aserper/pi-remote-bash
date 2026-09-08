import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { changeDirectoryCommand, parseTargetSpec, remoteScript, shellQuote, validateTarget } from "../src/ssh.ts";

const tempDirectories: string[] = [];

afterEach(() => {
	for (const path of tempDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("parseTargetSpec", () => {
	it("parses a bare SSH alias", () => {
		expect(parseTargetSpec("devbox.example.test")).toEqual({ target: "devbox.example.test", cwd: undefined });
	});

	it("parses colon and whitespace cwd forms", () => {
		expect(parseTargetSpec("deploy@devbox.example.test:/srv/example-app")).toEqual({
			target: "deploy@devbox.example.test",
			cwd: "/srv/example-app",
		});
		expect(parseTargetSpec("devbox.example.test ~/projects/example-app")).toEqual({
			target: "devbox.example.test",
			cwd: "~/projects/example-app",
		});
	});

	it("keeps spaces inside a colon-form cwd", () => {
		expect(parseTargetSpec("devbox.example.test:/srv/example app")).toEqual({
			target: "devbox.example.test",
			cwd: "/srv/example app",
		});
	});

	it("preserves bracketed IPv6 targets", () => {
		expect(parseTargetSpec("user@[2001:db8::1]:/srv/app")).toEqual({
			target: "user@[2001:db8::1]",
			cwd: "/srv/app",
		});
	});

	it("rejects targets that could be interpreted as SSH options", () => {
		expect(() => validateTarget("-oProxyCommand=bad")).toThrow("cannot start with '-'");
		expect(() => parseTargetSpec(" ")).toThrow("Usage:");
	});
});

describe("shell command construction", () => {
	it("quotes single quotes as one shell word", () => {
		const output = execFileSync("bash", ["-c", `printf '%s' ${shellQuote("it's safe")}`], { encoding: "utf8" });
		expect(output).toBe("it's safe");
	});

	it("constructs home-relative cwd commands", () => {
		expect(changeDirectoryCommand("~/projects/my app")).toBe(`cd -- "$HOME"/'projects/my app'`);
	});

	it("forwards only PI_ environment variables", () => {
		const script = remoteScript(`printf '%s|%s|%s' "$PI_MODEL" "\${OTHER-unset}" "\${PI_API_KEY-unset}"`, undefined, {
			PI_MODEL: "model'with-quote",
			OTHER: "must-not-forward",
			PI_API_KEY: "must-not-forward",
		});
		const output = execFileSync("bash", ["-c", script], { encoding: "utf8", env: {} });
		expect(output).toBe("model'with-quote|unset|unset");
	});

	it("executes multiline commands with nested quotes in the requested cwd", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-remote-bash test "));
		tempDirectories.push(cwd);
		const command = `cat <<'EOF'\nalpha "double quotes"\nbeta 'single quotes'\nEOF\nprintf 'cwd=%s\\n' "$PWD"`;
		const output = execFileSync("bash", ["-c", remoteScript(command, cwd)], { encoding: "utf8" });
		expect(output).toBe(`alpha "double quotes"\nbeta 'single quotes'\ncwd=${cwd}\n`);
	});
});
