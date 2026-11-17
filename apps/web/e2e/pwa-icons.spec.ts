import { expect, test } from "@playwright/test";
import { FakeSendo, routeFakeSendo } from "./fake-sendo";

test("ホーム画面とタブのアイコンを配信し、オフラインでも読み込める", async ({ page, context }) => {
  await routeFakeSendo(context, new FakeSendo());
  await page.goto("/");

  const icons = await page.evaluate(async () => {
    const manifestLink = document.querySelector<HTMLLinkElement>('link[rel="manifest"]');
    if (manifestLink === null) throw new Error("manifest がありません");
    const manifest = (await (await fetch(manifestLink.href)).json()) as {
      icons: { src: string; sizes: string; type: string; purpose: string }[];
    };
    return manifest.icons;
  });
  expect(icons).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ sizes: "192x192", type: "image/png", purpose: "any" }),
      expect.objectContaining({ sizes: "512x512", type: "image/png", purpose: "any" }),
      expect.objectContaining({ sizes: "512x512", type: "image/png", purpose: "maskable" }),
    ]),
  );

  const favicon = page.locator('link[rel="icon"]');
  const touchIcon = page.locator('link[rel="apple-touch-icon"]');
  await expect(favicon).toHaveAttribute("sizes", "32x32");
  await expect(touchIcon).toHaveAttribute("sizes", "180x180");
  const faviconUrl = await favicon.getAttribute("href");
  const touchIconUrl = await touchIcon.getAttribute("href");
  if (faviconUrl === null || touchIconUrl === null) throw new Error("アイコンの URL がありません");
  const images = [
    ...icons,
    { src: faviconUrl, sizes: "32x32" },
    { src: touchIconUrl, sizes: "180x180" },
  ];

  for (const icon of images) {
    const size = await page.evaluate(async (src) => {
      const image = new Image();
      image.src = src;
      await image.decode();
      return `${image.naturalWidth}x${image.naturalHeight}`;
    }, icon.src);
    expect(size).toBe(icon.sizes);
  }

  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await expect
    .poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null))
    .toBe(true);
  await context.setOffline(true);
  const contentTypes = await page.evaluate(
    async (sources) => {
      return Promise.all(
        sources.map(async (src) => {
          // ブラウザ自身の HTTP キャッシュではなく、Service Worker のキャッシュから読めるか
          const response = await fetch(src, { cache: "no-store" });
          if (!response.ok) throw new Error(`アイコンを読めません: ${src}`);
          return response.headers.get("content-type");
        }),
      );
    },
    images.map((icon) => icon.src),
  );
  expect(contentTypes).toEqual(images.map(() => "image/png"));
});
