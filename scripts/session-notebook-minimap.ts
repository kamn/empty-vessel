/// <reference lib="dom" />
// Trusted viewer UI only: saved session content is data, never executable code.
export type MinimapEntry = { line: number; label: string; description: string; kind: string }

// Serialized into the standalone report; keep this function self-contained.
export function installMinimap() {
  const rail = document.querySelector<HTMLElement>(".minimap")
  if (!rail) return
  const entries = JSON.parse(rail.dataset.entries || "[]") as MinimapEntry[]
  const canvas = rail.querySelector<HTMLCanvasElement>("canvas")!
  const tip = document.querySelector<HTMLElement>("#minimap-tip")!
  const status = document.querySelector<HTMLElement>("#minimap-status")!
  const ctx = canvas.getContext("2d")
  const events = entries.map(e => document.getElementById(`event-${e.line}`))
  let current = 0
  let hovered: number | undefined
  let frame = 0
  const clamp = (n: number) => Math.max(0, Math.min(entries.length - 1, n))
  const indexAt = (y: number) => {
    const rect = rail.getBoundingClientRect()
    return clamp(Math.round((y - rect.top) / Math.max(1, rect.height) * (entries.length - 1)))
  }
  const describe = (index: number) => {
    const entry = entries[index]
    if (!entry) return
    tip.textContent = `${entry.label}\n${entry.description}`
    const selected = entries[current]!
    rail.setAttribute("aria-valuetext", `${current + 1} of ${entries.length}: ${selected.label}. ${selected.description}`)
  }
  const paint = () => {
    if (!ctx) return
    const h = Math.max(1, Math.round(rail.getBoundingClientRect().height))
    const w = 40
    const scale = window.devicePixelRatio || 1
    canvas.width = w * scale
    canvas.height = h * scale
    ctx.scale(scale, scale)
    ctx.clearRect(0, 0, w, h)
    ctx.fillStyle = "#d9dee3"
    ctx.fillRect(19, 0, 2, h)
    // At most one mark per two CSS pixels, regardless of session length.
    const buckets = Math.min(entries.length, Math.max(1, Math.floor(h / 2)))
    for (let b = 0; b < buckets; b++) {
      const first = Math.floor(b * entries.length / buckets)
      const entry = entries[first]!
      ctx.fillStyle = entry.kind === "user" ? "#2859a1" : entry.kind === "check" ? "#a36627" : entry.kind === "command" ? "#33775c" : "#93a1b3"
      const y = buckets <= 1 ? 0 : b / (buckets - 1) * (h - 2)
      ctx.fillRect(10, y, 20, 2)
    }
    ctx.fillStyle = "#172b49"
    ctx.fillRect(2, entries.length <= 1 ? 0 : current / (entries.length - 1) * (h - 4), 36, 4)
  }
  const jump = (index: number) => {
    const retainFocus = document.activeElement === rail
    current = clamp(index)
    const event = events[current]
    if (!event) return
    const quiet = event.querySelector<HTMLDetailsElement>("details.quiet")
    if (quiet) quiet.open = true
    event.scrollIntoView({ block: "start" })
    // Local file URLs also work; do not depend on History API permissions.
    window.location.hash = event.id
    if (retainFocus) rail.focus({ preventScroll: true })
    rail.setAttribute("aria-valuenow", String(current + 1))
    status.textContent = `${current + 1} / ${entries.length}`
    describe(current)
    paint()
  }
  if (!entries.length) {
    rail.setAttribute("aria-disabled", "true")
    status.textContent = "No records"
    return
  }
  rail.parentElement?.querySelectorAll<HTMLAnchorElement>("a").forEach((link, i) => {
    link.addEventListener("click", event => { event.preventDefault(); jump(i === 0 ? 0 : entries.length - 1) })
  })
  rail.addEventListener("pointermove", event => {
    hovered = indexAt(event.clientY)
    describe(hovered)
    tip.hidden = false
  })
  rail.addEventListener("pointerleave", () => {
    hovered = undefined
    tip.hidden = document.activeElement !== rail
    describe(current)
  })
  rail.addEventListener("pointerdown", event => {
    if (event.button !== 0) return
    event.preventDefault()
    rail.focus({ preventScroll: true })
    jump(indexAt(event.clientY))
    tip.hidden = false
  })
  rail.addEventListener("focus", () => { describe(current); tip.hidden = false })
  rail.addEventListener("blur", () => { tip.hidden = true })
  rail.addEventListener("keydown", event => {
    const next = event.key === "Home" ? 0 : event.key === "End" ? entries.length - 1
      : event.key === "ArrowDown" || event.key === "ArrowRight" ? current + 1
      : event.key === "ArrowUp" || event.key === "ArrowLeft" ? current - 1
      : event.key === "PageDown" ? current + Math.max(1, Math.round(entries.length / 10))
      : event.key === "PageUp" ? current - Math.max(1, Math.round(entries.length / 10)) : undefined
    if (event.key === "Escape") tip.hidden = true
    if (next === undefined) return
    event.preventDefault()
    jump(next)
  })
  const sync = () => {
    frame = 0
    let lo = 0, hi = events.length - 1
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2)
      if ((events[mid]?.getBoundingClientRect().bottom ?? 0) < 24) lo = mid + 1
      else hi = mid
    }
    current = window.scrollY > 0 && window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2 ? entries.length - 1 : lo
    rail.setAttribute("aria-valuenow", String(current + 1))
    status.textContent = `${current + 1} / ${entries.length}`
    if (hovered === undefined) describe(current)
    paint()
  }
  window.addEventListener("scroll", () => { if (!frame) frame = requestAnimationFrame(sync) }, { passive: true })
  window.addEventListener("resize", sync)
  sync()
}

export const minimapScript = `(${installMinimap.toString()})();`
