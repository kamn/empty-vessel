// A file embedded in the compiled executable (import … with { type: "file" }): its path, to read with Bun.file.
declare module "*.tar.gz" {
  const path: string
  export default path
}
