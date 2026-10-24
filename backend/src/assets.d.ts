/** Asset Bun (`import font from "./font.ttf" with { type: "file" }`). */
declare module "*.ttf" {
  const path: string;
  export default path;
}
