/** esbuild が文字として取り込む HTML（x-embed-page.ts） */
declare module "*.html" {
  const text: string;
  export default text;
}
