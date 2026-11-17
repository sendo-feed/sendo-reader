import { expect, test } from "@playwright/test";
import { FakeSendo, routeFakeSendo, signIn } from "./fake-sendo";

for (const [locale, timezoneId] of [
  ["ja-JP", "Asia/Tokyo"],
  ["en-US", "America/Los_Angeles"],
] as const) {
  test.describe(`${locale} / ${timezoneId}`, () => {
    test.use({ locale, timezoneId });

    test("バージョンの日時は端末のロケールとタイムゾーンで表示する", async ({ page, context }) => {
      await routeFakeSendo(context, new FakeSendo());
      await page.goto("/settings");
      await signIn(page);
      const version = page.locator(".settings .version");
      await expect(version).toContainText(/^Version [0-9a-f]{7} \(/);
      const time = version.locator("time");
      const iso = await time.getAttribute("datetime");
      if (iso === null) throw new Error("ビルド日時がない");
      expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      const expected = new Intl.DateTimeFormat(locale, {
        timeZone: timezoneId,
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(iso));
      await expect(time).toHaveText(expected);

      // 表示は開いた時刻ではなくビルド日時。端末の時計を進めて開き直しても変わらない。
      await page.clock.install({ time: new Date("2030-01-01T00:00:00Z") });
      await page.reload();
      await expect(time).toHaveAttribute("datetime", iso);
      await expect(time).toHaveText(expected);
    });
  });
}
