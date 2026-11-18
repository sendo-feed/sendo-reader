import { expect, test } from "@playwright/test";
import { FakeSendo, routeFakeSendo, signIn } from "./fake-sendo";

test("Saved から URL を保存し、別端末でも元ページを開いて保存解除できる", async ({
  browser,
  page,
  context,
}) => {
  const server = new FakeSendo();
  await routeFakeSendo(context, server);
  await page.goto("/starred");
  await signIn(page);

  const url = "https://x.com/example/status/1234567890#post";
  await page.getByRole("button", { name: "Save a URL" }).click();
  const dialog = page.getByRole("dialog", { name: "Save a URL" });
  await dialog.getByLabel("Page URL").fill(url);
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("link", { name: url })).toHaveAttribute("href", url);
  const sync = page.getByRole("button", { name: "Sync now" });
  await sync.click();
  await expect(sync).toBeEnabled();
  expect(server.requests).toContain("PUT /saved");

  const otherContext = await browser.newContext();
  try {
    await routeFakeSendo(otherContext, server);
    await otherContext.route("https://x.com/example/**", (route) =>
      route.fulfill({ body: "Saved post" }),
    );
    const other = await otherContext.newPage();
    await other.goto(page.url());
    await signIn(other);
    const link = other.getByRole("link", { name: url });
    const [opened] = await Promise.all([other.waitForEvent("popup"), link.click()]);
    await expect(opened.locator("body")).toHaveText("Saved post");
    await opened.close();
    await other.getByRole("button", { name: `Remove saved link ${url}` }).click();
    await expect(link).toHaveCount(0);
    const otherSync = other.getByRole("button", { name: "Sync now" });
    await otherSync.click();
    await expect(otherSync).toBeEnabled();
    expect(server.requests.some((request) => request.startsWith("DELETE /saved/"))).toBeTruthy();
    await sync.click();
    await expect(sync).toBeEnabled();
    await expect(page.getByRole("link", { name: url })).toHaveCount(0);
  } finally {
    await otherContext.close();
  }
});
