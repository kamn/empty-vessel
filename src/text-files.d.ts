// Text files imported into the code (import text from "./x.md" with { type: "text" }): their contents as a string.
declare module "*.md" {
  const text: string
  export default text
}
