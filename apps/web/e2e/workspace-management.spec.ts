import { expect, test } from "@playwright/test";
import { FakeSendo, routeFakeSendo, signIn } from "./fake-sendo";

test("ワークスペースを作成・改名し、購読のフォルダを保ったまま移してから空の default を削除する", async ({
  context,
  page,
}) => {
  const server = new FakeSendo();
  server.workspacesSupported = true;
  const original = server.createWorkspace("default");
  const folder = server.createFolder("Technology");
  const feed = server.subscribe({
    url: "https://example.test/feed",
    title: "Blog",
    folderId: folder.id,
    workspaceId: original.id,
  });
  await routeFakeSendo(context, server);
  await page.goto("/manage");
  await signIn(page);

  const manage = page.getByRole("main");
  const workspaces = manage.getByRole("button", { name: "Workspaces", exact: true });
  await workspaces.click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Edit default" }).click();
  await expect(
    dialog.getByText("削除するには、中の購読をすべて移動するか、解除してください。"),
  ).toBeVisible();
  await dialog.getByRole("textbox", { name: "Workspace name" }).fill("Public");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await dialog.getByRole("button", { name: "New workspace" }).click();
  await dialog.getByRole("textbox", { name: "Workspace name" }).fill("Personal");
  await dialog.getByRole("button", { name: "Create workspace" }).click();
  await expect(dialog.getByRole("button", { name: "Edit Personal" })).toBeVisible();
  await dialog.getByRole("button", { name: "Close" }).click();

  const technology = manage.getByRole("region", { name: "Technology", exact: true });
  await technology.getByRole("button", { name: "Feed options: Blog" }).click();
  await dialog.getByRole("button", { name: "Move to workspace…" }).click();
  await dialog.getByLabel("Workspace", { exact: true }).selectOption({ label: "Personal" });
  await dialog.getByRole("button", { name: "Move feed", exact: true }).click();
  await expect(technology).toContainText("Blog");

  await workspaces.click();
  await dialog.getByRole("button", { name: "Edit Public" }).click();
  await dialog.getByRole("button", { name: "Delete workspace…" }).click();
  await dialog.getByRole("button", { name: "Delete workspace", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Edit Public" })).toHaveCount(0);
  await expect.poll(() => original.deletedAt).not.toBeNull();
  expect(feed.folderId).toBe(folder.id);
  expect(server.workspaces.get(feed.workspaceId ?? "")?.name).toBe("Personal");
});

test("All で購読するたびに、追加先は未割り当てから選べる", async ({ context, page }) => {
  const server = new FakeSendo();
  server.workspacesSupported = true;
  const workspace = server.createWorkspace("Personal");
  const first = "https://first.example/feed";
  const second = "https://second.example/feed";
  for (const url of [first, second]) {
    server.discoverable.set(url, [{ url, title: url }]);
    server.fetchable.set(url, url);
  }
  await routeFakeSendo(context, server);
  await page.goto("/manage");
  await signIn(page);
  await expect(page.getByRole("button", { name: "Workspaces", exact: true })).toBeVisible();

  const add = page.getByRole("button", { name: "Add feed", exact: true });
  const dialog = page.getByRole("dialog", { name: "Add feed", exact: true });
  const discover = async (url: string) => {
    await add.click();
    await dialog.getByLabel("Website or feed URL").fill(url);
    await dialog.getByRole("button", { name: "Find", exact: true }).click();
  };
  await discover(first);
  await dialog.getByText("No workspace", { exact: true }).first().click();
  await dialog.getByLabel("Workspace", { exact: true }).selectOption(workspace.id);
  await dialog.getByRole("button", { name: "Subscribe", exact: true }).click();
  await expect(dialog).not.toBeVisible();

  await discover(second);
  await expect(dialog.getByRole("group", { name: "Feeds" }).locator("summary")).toHaveText(
    "No workspace",
  );
  await dialog.getByRole("button", { name: "Subscribe", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect([...server.feeds.values()].map((feed) => feed.workspaceId)).toEqual([workspace.id, null]);
});
