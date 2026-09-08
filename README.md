# pi-remote-bash

[![CI](https://img.shields.io/github/actions/workflow/status/aserper/pi-remote-bash/ci.yml?style=for-the-badge&logo=github&label=CI)](https://github.com/aserper/pi-remote-bash/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/pi-remote-bash?style=for-the-badge&logo=npm&logoColor=white)](https://www.npmjs.com/package/pi-remote-bash)
[![License: MIT](https://img.shields.io/npm/l/pi-remote-bash?style=for-the-badge)](https://github.com/aserper/pi-remote-bash/blob/main/LICENSE)
[![Pi extension](https://img.shields.io/badge/pi-extension-blueviolet?style=for-the-badge)](https://pi.dev/packages)

Run complex Bash commands over SSH from [Pi](https://pi.dev) without making the model reconstruct nested `ssh '...'` quoting on every call.

`pi-remote-bash` adds one tool, `remote_bash`, plus `/ssh` and `/local` commands for selecting a default target. It intentionally leaves Pi's ordinary `read`, `write`, `edit`, `bash`, `grep`, `find`, and `ls` tools local.

## Why?

Pi can already execute `ssh host command` through its normal Bash tool. That works well for simple commands, but becomes fragile when commands contain nested quotes, heredocs, variables, command substitutions, or embedded languages such as `awk` and Python.

`remote_bash` keeps the SSH transport separate from the command payload:

```text
remote_bash({
  target: "staging",
  command: "awk 'NR > 5 { print $1 }' app.log | tail -20"
})
```

The extension passes arguments directly to the system OpenSSH client. It base64-encodes the Bash program, then decodes it on the remote host before execution, so the account's login shell never has to reinterpret the command's quotes or newlines.

## Features

- One explicit `remote_bash` tool; no built-in tool overrides
- Selected host and working directory for the current Pi session
- One-off target and cwd overrides
- Streaming stdout and stderr
- Cancellation and configurable timeouts
- Pi's built-in Bash output truncation and full-output preservation
- Native OpenSSH behavior: `~/.ssh/config`, ssh-agent, ProxyJump, aliases, and ControlMaster
- Does not conflict with extensions that replace Pi's local Bash or edit tools; their local-only behavior is not applied to `remote_bash`
- No SFTP layer, credential store, endpoint database, tunnels, or remote-workspace abstraction

## Install

### From npm

```bash
pi install npm:pi-remote-bash
```

Restart Pi or run `/reload`.

### From GitHub

```bash
pi install git:github.com/aserper/pi-remote-bash
```

## Usage

### Select a default target

```text
/ssh deploy@devbox.example.test
/ssh deploy@devbox.example.test:/srv/example-app
/ssh deploy@devbox.example.test /srv/example-app
```

The footer displays the active target:

```text
SSH: deploy@devbox.example.test:/srv/example-app
```

Pi can then call `remote_bash` without repeating the target:

```text
remote_bash({ command: "git status --short && npm test" })
```

Run `/ssh` with no arguments to inspect the current selection.

### One-off command

A selected target is optional:

```text
remote_bash({
  target: "ops@worker.example.test",
  cwd: "/srv/example-worker",
  command: "./example-worker status && tail -n 50 logs/worker.log"
})
```

A one-off `target` or `cwd` does not alter the selected session defaults.

### Return to local-only context

```text
/local
```

`/ssh off` is equivalent.

## Complex-command example

This passes through nested quotes, variables, a heredoc, and an embedded `awk` program without requiring an outer SSH-escaping layer:

```bash
tmp=$(mktemp)
cat > "$tmp" <<'EOF'
alpha "double quotes"
beta 'single quotes'
literal $HOME and `hostname`
EOF
awk 'NR == 2 { printf "line=%s | length=%d\n", toupper($0), length($0) }' "$tmp"
printf 'remote=%s\n' "$(hostname)"
rm -f "$tmp"
```

## Commands

| Command | Purpose |
| --- | --- |
| `/ssh TARGET` | Verify and select an SSH target using its login directory |
| `/ssh TARGET:/PATH` | Select a target and persistent remote cwd |
| `/ssh` | Show the selected target and cwd |
| `/ssh off` | Clear the selection |
| `/local` | Clear the selection |

## Tool parameters

| Parameter | Required | Description |
| --- | --- | --- |
| `command` | yes | Bash command to execute remotely |
| `target` | no | One-off `user@host` or OpenSSH alias; defaults to `/ssh` selection |
| `cwd` | no | One-command working-directory override |
| `timeout` | no | Timeout in seconds; defaults to 30, maximum 3600 |

## SSH configuration

The extension runs your system `ssh` executable rather than implementing SSH itself. Put ports, keys, jumps, and connection reuse in `~/.ssh/config`:

```sshconfig
Host staging
  HostName staging.example.com
  User deploy
  IdentityFile ~/.ssh/id_ed25519
  ProxyJump bastion
  ControlMaster auto
  ControlPersist 10m
  ControlPath ~/.ssh/control-%C
```

Then use:

```text
/ssh staging:/srv/app
```

`BatchMode=yes` and a 10-second SSH connection timeout are enforced, so commands fail instead of hanging on password prompts or stalled connections. Authenticate with ssh-agent or key configuration and accept new host keys through normal OpenSSH first.

## Operational notes

- The remote host must provide `bash` and `base64`.
- Pi's `PI_*` session metadata variables are forwarded to the remote Bash process.
- Local Pi tools remain local even after `/ssh`; use `remote_bash` with bounded `cat`, `sed`, `rg`, or similar commands for remote files.
- Cancellation or timeout terminates the local SSH client. A remote process may survive; use `nohup` with explicit output redirection for intentional background jobs.
- The selected target is in memory only and is cleared by `/reload`, `/new`, `/resume`, or restarting Pi.

## Development

```bash
npm install
npm run typecheck
npm test
npm run pack:check
```

## Publishing future releases

The package uses the same release flow as [`rtfd-pi`](https://github.com/aserper/rtfd-pi):

```bash
npm version patch
git push --follow-tags
```

A pushed `v*` tag runs checks and publishes to npm. The `pi-package` keyword and `pi.extensions` manifest make releases discoverable automatically in the [Pi package gallery](https://pi.dev/packages).

## License

MIT
