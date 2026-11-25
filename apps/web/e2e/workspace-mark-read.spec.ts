import { expect, test } from "@playwright/test";
import { FakeSendo, routeFakeSendo, signIn } from "./fake-sendo";

test("オフラインで Public を既読にし、後から表示を切り替えても Personal を既読にしない", async ({
  page,
  context,
}) => {
  const server = new FakeSendo();
  server.workspacesSupported = true;
  const publicSpace = server.createWorkspace("Public");
  const privateSpace = server.createWorkspace("Personal");
  const publicFeed = server.subscribe({
    url: "https://public.example/feed",
    workspaceId: publicSpace.id,
  });
  const privateFeed = server.subscribe({
    url: "https://private.example/feed",
    workspaceId: privateSpace.id,
  });
  const publicArticle = server.deliver(publicFeed.id, { title: "Public article" });
  const privateArticle = server.deliver(privateFeed.id, { title: "Personal article" });

  await routeFakeSendo(context, server);
  await page.goto("/");
  await signIn(page);
  const switcher = page.getByRole("button", { name: /^Workspaces:/ });
  const scope = page.getByRole("dialog", { name: "Workspaces", exact: true });
  const select = async (name: string) => {
    await switcher.click();
    await scope.getByRole("button", { name, exact: true }).click();
    await scope.getByRole("button", { name: "Close", exact: true }).click();
  };
  await select("Only Public");
  const list = page.locator(".article-list");
  await expect(list.locator(".row.unread")).toHaveCount(1);
  await context.setOffline(true);

  await list.locator(".end").getByRole("button", { name: "Mark all as read", exact: true }).click();
  await expect(list.locator(".row.unread")).toHaveCount(0);
  await select("Only Personal");
  await expect(list.locator(".row.unread")).toHaveCount(1);
  await expect(list.getByText("Personal article")).toBeVisible();

  await context.setOffline(false);
  await page.getByRole("button", { name: "Sync now" }).click();
  await expect.poll(() => publicArticle.readAt).not.toBeNull();
  expect(privateArticle.readAt).toBeNull();
  expect(server.markReadRequests).toMatchObject([{ subscriptionIds: [publicFeed.subscriptionId] }]);
});
