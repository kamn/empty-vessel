// Put text on the clipboard: pbcopy on macOS, else OSC 52, which the terminal itself copies (iTerm2, Ghostty, WezTerm,
// kitty, tmux with set-clipboard, and over SSH too). pbcopy failing (or missing) falls back to OSC 52 instead of throwing:
// a copy must never take the TUI down.
export const osc52 = (text: string) => `\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`

export const copyText = (text: string, platform: string = process.platform, write: (s: string) => void = (s) => { process.stdout.write(s) }) => {
  if (platform === "darwin") {
    try {
      if (Bun.spawnSync(["pbcopy"], { stdin: new TextEncoder().encode(text) }).exitCode === 0) return
    } catch {} // no pbcopy: the terminal's way below
  }
  write(osc52(text))
}
