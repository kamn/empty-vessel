import { expect, test } from "bun:test"
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fromSaved, imageItem, imagesIn, loadImage, toSaved } from "../../src/base/images"

// A 40×20 PNG, red on the left half, blue on the right.
const PNG_BYTES = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAACgAAAAUCAIAAABwJOjsAAAAKUlEQVR4nGO4oKBANlJwuEA2Yhi1eNTiUYtHLR61eNTiUYtHLR45FgMADmuELvquDp8AAAAASUVORK5CYII=", "base64")
const PNG = join(mkdtempSync(join(tmpdir(), "empty-vessel-img-")), "probe.png")
writeFileSync(PNG, PNG_BYTES)

test("image paths in a message: escaped spaces, quotes, relative; only files that exist; each becomes its label", () => {
  const dir = mkdtempSync(join(tmpdir(), "empty-vessel-img-"))
  mkdirSync(join(dir, "shots"))
  copyFileSync(PNG, join(dir, "Screen Shot 1.png"))
  copyFileSync(PNG, join(dir, "shots", "b.jpg"))
  writeFileSync(join(dir, "notes.txt"), "not an image")

  const text = `Compare ${join(dir, "Screen\\ Shot\\ 1.png")}, with "shots/b.jpg" and ./missing.png, see notes.txt`
  const { images, text: labelled } = imagesIn(text, dir)
  expect(images).toEqual([{ label: "[Image #1]", path: join(dir, "Screen Shot 1.png") }, { label: "[Image #2]", path: join(dir, "shots", "b.jpg") }])
  expect(labelled).toBe("Compare [Image #1], with [Image #2] and ./missing.png, see notes.txt") // the comma after a path isn't part of it
  expect(imagesIn(text, dir, 3).images[0]!.label).toBe("[Image #3]") // counting on from the TUI's labels
})

test("an image is sent as its type and base64 bytes", () => {
  const img = loadImage(PNG)
  expect(img.mediaType).toBe("image/png")
  expect(Buffer.from(img.data, "base64").subarray(1, 4).toString()).toBe("PNG")
})

test("the session stores an image's path, not its bytes; resuming reads it again (or notes that it's gone)", () => {
  const message = { role: "user", content: [{ type: "input_text", text: "look at [Image #1]" }, imageItem(PNG)] }
  const sent = JSON.parse(JSON.stringify(message))
  expect(sent.content[1].image_url).toStartWith("data:image/png;base64,") // what the API gets: no path in it
  expect(JSON.stringify(sent)).not.toContain(PNG)

  const saved = JSON.parse(JSON.stringify(toSaved(message)))
  expect(saved.content[1]).toEqual({ type: "input_image", emptyVesselPath: PNG }) // what the session file gets: no bytes
  expect(JSON.stringify(saved).length).toBeLessThan(300)

  const back = fromSaved(saved) as { content: Array<{ image_url?: string }> }
  expect(back.content[1]!.image_url).toBe(sent.content[1].image_url)
  expect(fromSaved({ role: "user", content: [{ type: "input_image", emptyVesselPath: "/nope/gone.png" }] })).toEqual({ role: "user", content: [{ type: "input_text", text: "[an image that's no longer there: /nope/gone.png]" }] })
})
