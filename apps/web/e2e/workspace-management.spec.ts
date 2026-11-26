import { expect, test } from "@playwright/test";
import { FakeSendo, routeFakeSendo, signIn } from "./fake-sendo";

test("購読管理で空のデフォルトの削除を防ぎ、切り替え後に旧デフォルトを削除できる", async ({
  context,
  page,
}) => {
  const server = new FakeSendo();
  server.workspacesSupported = true;
  const original = server.createWorkspace("default");
  const personal = server.createWorkspace("Personal");
  server.setDefaultWorkspace(original.id);
  await routeFakeSendo(context, server);
  await page.goto("/manage");
  await signIn(page);
  await page.getByRole("main").getByRole("button", { name: "Workspaces", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Workspaces", exact: true });
  const row = (name: string) =>
    dialog
      .getByRole("listitem")
      .filter({ has: page.getByRole("button", { name: `Edit ${name}` }) });
  await expect(row("default").getByText("Default", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Edit default" }).click();
  await expect(
    dialog.getByText("削除するには、先に別のワークスペースをデフォルトにしてください。"),
  ).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Delete workspace…" })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await dialog.getByRole("button", { name: "Edit Personal" }).click();
  await dialog.getByRole("button", { name: "Make default" }).click();
  await expect(dialog.getByRole("button", { name: "Make default" })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(row("Personal").getByText("Default", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Edit default" }).click();
  await dialog.getByRole("button", { name: "Delete workspace…" }).click();
  await dialog.getByRole("button", { name: "Delete workspace", exact: true }).click();
  await expect.poll(() => server.workspaceDefaultId).toBe(personal.id);
  await expect.poll(() => original.deletedAt).not.toBeNull();
});

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

test("対応 Sendo では表示範囲によらずデフォルトで購読し、明示先で上書きできる", async ({
  context,
  page,
}) => {
  const server = new FakeSendo();
  server.workspacesSupported = true;
  server.defaultWorkspaceOnSubscribe = true;
  const initial = server.createWorkspace("default");
  const personal = server.createWorkspace("personal");
  server.setDefaultWorkspace(personal.id);
  const urls = [
    "https://www.apple.com/newsroom/rss-feed.rss",
    "https://github.blog/feed/",
    "https://www.w3.org/blog/feed/",
    "https://blog.cloudflare.com/rss/",
    "https://hnrss.org/newest?q=Claude",
  ] as const;
  for (const url of urls) {
    server.discoverable.set(url, [{ url, title: url }]);
    server.fetchable.set(url, url);
  }
  await routeFakeSendo(context, server);
  await page.goto("/manage");
  await signIn(page);

  const scope = page.getByRole("button", { name: /^Workspaces:/ });
  const switcher = page.getByRole("dialog", { name: "Workspaces", exact: true });
  const dialog = page.getByRole("dialog", { name: "Add feed", exact: true });
  const summary = dialog.getByRole("group", { name: "Feeds" }).locator("summary");
  const subscribe = dialog.getByRole("button", { name: "Subscribe", exact: true });
  const openFeed = async (url: string) => {
    await page.getByRole("button", { name: "Add feed", exact: true }).click();
    await dialog.getByLabel("Website or feed URL").fill(url);
    await dialog.getByRole("button", { name: "Find", exact: true }).click();
    await expect(summary).toHaveText("Use default");
    await expect(subscribe).toBeEnabled();
  };
  const finish = async () => {
    await subscribe.click();
    await expect(dialog).not.toBeVisible();
  };

  await openFeed(urls[0]);
  await finish();
  await scope.click();
  await switcher.getByRole("button", { name: "Only default", exact: true }).click();
  await switcher.getByRole("button", { name: "Close", exact: true }).click();
  await openFeed(urls[1]);
  await expect(dialog.getByText("閲覧範囲外のデフォルトに追加します。")).toBeVisible();
  await summary.click();
  await expect(
    dialog.getByRole("option", { name: "Use default (personal)", exact: true }),
  ).toHaveCount(1);
  await finish();
  await expect(page.getByText("購読しました。追加先は現在の閲覧範囲外です。")).toBeVisible();
  await expect(scope).toHaveAccessibleName("Workspaces: default");

  await openFeed(urls[2]);
  await summary.click();
  await dialog.getByLabel("Workspace", { exact: true }).selectOption(initial.id);
  await finish();
  await expect(page.getByText("購読しました。", { exact: true })).toBeVisible();
  await scope.click();
  await switcher.getByRole("checkbox", { name: "personal", exact: true }).check();
  await switcher.getByRole("button", { name: "Close", exact: true }).click();
  await openFeed(urls[3]);
  await finish();

  await scope.click();
  await switcher.getByRole("button", { name: "Clear selection", exact: true }).click();
  await switcher.getByRole("button", { name: "Close", exact: true }).click();
  await openFeed(urls[4]);
  await finish();
  expect(server.subscribeRequests).toEqual(
    urls.map((url, index) => ({
      url,
      folderId: null,
      ...(index === 2 && { workspaceId: initial.id }),
    })),
  );
  expect([...server.feeds.values()].map((row) => row.workspaceId)).toEqual([
    personal.id,
    personal.id,
    initial.id,
    personal.id,
    personal.id,
  ]);
});

test("購読先の省略に未対応の Sendo では、デフォルトが同期されても明示先を選ぶ", async ({
  context,
  page,
}) => {
  const server = new FakeSendo();
  server.workspacesSupported = true;
  const initial = server.createWorkspace("default");
  const personal = server.createWorkspace("personal");
  server.setDefaultWorkspace(personal.id);
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

test("明示したワークスペースが削除されたら、デフォルトを選び直して購読できる", async ({
  context,
  page,
}) => {
  const server = new FakeSendo();
  server.workspacesSupported = true;
  const original = server.createWorkspace("default");
  const personal = server.createWorkspace("personal");
  server.setDefaultWorkspace(original.id);
  server.defaultWorkspaceOnSubscribe = true;
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
  await expect(workspace).toHaveValue("");
  await workspace.selectOption({ label: "Use default (default)" });
  await expect(subscribe).toBeEnabled();
  await subscribe.click();
  await expect(dialog).not.toBeVisible();
  expect([...server.feeds.values()].map((feed) => feed.workspaceId)).toEqual([original.id]);
});
