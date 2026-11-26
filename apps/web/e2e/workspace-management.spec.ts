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

test("フィード購読は All・複数・0 件の表示で所属先を選び、単独表示ではその先を初期値にする", async ({
  context,
  page,
}) => {
  const server = new FakeSendo();
  server.workspacesSupported = true;
  const initial = server.createWorkspace("default");
  const personal = server.createWorkspace("personal");
  const [first, second, single, multiple, empty] = [
    "https://first.example/feed",
    "https://second.example/feed",
    "https://single.example/feed",
    "https://multiple.example/feed",
    "https://empty.example/feed",
  ] as const;
  for (const url of [first, second, single, multiple, empty]) {
    server.discoverable.set(url, [{ url, title: url }]);
    server.fetchable.set(url, url);
  }
  await routeFakeSendo(context, server);
  await page.goto("/manage");
  await signIn(page);

  const scope = page.getByRole("button", { name: /^Workspaces:/ });
  const switcher = page.getByRole("dialog", { name: "Workspaces", exact: true });
  const add = page.getByRole("button", { name: "Add feed", exact: true });
  const dialog = page.getByRole("dialog", { name: "Add feed", exact: true });
  const summary = dialog.getByRole("group", { name: "Feeds" }).locator("summary");
  const subscribe = dialog.getByRole("button", { name: "Subscribe", exact: true });
  const discover = async (url: string) => {
    await add.click();
    await dialog.getByLabel("Website or feed URL").fill(url);
    await dialog.getByRole("button", { name: "Find", exact: true }).click();
  };
  const choose = async (id: string) => {
    await expect(subscribe).toBeDisabled();
    await expect(summary).toHaveText("Choose workspace");
    await summary.click();
    const workspace = dialog.getByLabel("Workspace", { exact: true });
    await expect(workspace.getByRole("option", { name: "No workspace", exact: true })).toHaveCount(
      0,
    );
    await workspace.selectOption(id);
    await subscribe.click();
    await expect(dialog).not.toBeVisible();
  };
  await expect(scope).toHaveAccessibleName("Workspaces: All workspaces");
  await discover(first);
  await choose(personal.id);
  await discover(second);
  await choose(initial.id);

  await scope.click();
  await switcher.getByRole("button", { name: "Only default", exact: true }).click();
  await switcher.getByRole("button", { name: "Close", exact: true }).click();
  await discover(single);
  await expect(summary).toHaveText("default");
  await subscribe.click();
  await expect(dialog).not.toBeVisible();

  await scope.click();
  await switcher.getByRole("checkbox", { name: "personal", exact: true }).check();
  await switcher.getByRole("button", { name: "Close", exact: true }).click();
  await discover(multiple);
  await choose(personal.id);

  await scope.click();
  await switcher.getByRole("button", { name: "Clear selection", exact: true }).click();
  await switcher.getByRole("button", { name: "Close", exact: true }).click();
  await discover(empty);
  await choose(initial.id);
  expect([...server.feeds.values()].map((feed) => [feed.url, feed.workspaceId])).toEqual([
    [first, personal.id],
    [second, initial.id],
    [single, initial.id],
    [multiple, personal.id],
    [empty, initial.id],
  ]);
});

for (const { supported, guidance } of [
  { supported: false, guidance: "ワークスペースに対応した Sendo と同期してください。" },
  { supported: true, guidance: "先にワークスペースを作成してください。" },
]) {
  test(`所属先を使えないときは案内を出して購読を止める（対応: ${supported}）`, async ({
    context,
    page,
  }) => {
    const server = new FakeSendo();
    server.workspacesSupported = supported;
    const url = "https://blog.example/feed";
    server.discoverable.set(url, [{ url, title: "Blog" }]);
    server.fetchable.set(url, "Blog");
    await routeFakeSendo(context, server);
    await page.goto("/manage");
    await signIn(page);
    await expect(page.getByRole("button", { name: "Sync now", exact: true })).toHaveAttribute(
      "title",
      /Synced /,
    );
    if (supported) {
      await expect(page.getByRole("button", { name: "Workspaces", exact: true })).toBeVisible();
    }
    await page.getByRole("button", { name: "Add feed", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Add feed", exact: true });
    await dialog.getByLabel("Website or feed URL").fill(url);
    await dialog.getByRole("button", { name: "Find", exact: true }).click();
    await expect(dialog.getByText(guidance)).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Subscribe", exact: true })).toBeDisabled();
    expect(server.requests).not.toContain("POST /feeds");
  });
}

test("選んだワークスペースが別の操作で削除されたら、候補から選び直して購読できる", async ({
  context,
  page,
}) => {
  const server = new FakeSendo();
  server.workspacesSupported = true;
  const original = server.createWorkspace("default");
  const personal = server.createWorkspace("personal");
  const url = "https://blog.example/feed";
  server.discoverable.set(url, [{ url, title: "Blog" }]);
  server.fetchable.set(url, "Blog");
  await routeFakeSendo(context, server);
  await page.goto("/manage");
  await signIn(page);
  await page.getByRole("button", { name: "Workspaces", exact: true }).waitFor();
  await page.getByRole("button", { name: "Add feed", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add feed", exact: true });
  await dialog.getByLabel("Website or feed URL").fill(url);
  await dialog.getByRole("button", { name: "Find", exact: true }).click();
  await dialog.getByRole("group", { name: "Feeds" }).locator("summary").click();
  const workspace = dialog.getByLabel("Workspace", { exact: true });
  await workspace.selectOption(personal.id);

  expect(
    await page.evaluate(async (id) => {
      const response = await fetch(`/api/v1/workspaces/${id}`, { method: "DELETE" });
      return response.status;
    }, personal.id),
  ).toBe(204);
  const syncRequests = () =>
    server.requests.filter((request) => request.startsWith("GET /sync?")).length;
  const beforeSync = syncRequests();
  const subscribe = dialog.getByRole("button", { name: "Subscribe", exact: true });
  await subscribe.click();
  await expect(dialog.getByRole("alert")).toHaveText("そのワークスペースはもうありません。");
  expect(server.feeds.size).toBe(0);
  await expect(subscribe).toBeDisabled();
  await expect.poll(syncRequests).toBeGreaterThan(beforeSync);
  await expect(workspace.getByRole("option", { name: "personal", exact: true })).toHaveCount(0);
  await workspace.selectOption(original.id);
  await subscribe.click();
  await expect(dialog).not.toBeVisible();
  expect([...server.feeds.values()].map((feed) => feed.workspaceId)).toEqual([original.id]);
});
