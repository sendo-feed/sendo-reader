import { expect, type Locator, type Page, type Route, test } from "@playwright/test";
import { FakeSendo, routeFakeSendo, signIn } from "./fake-sendo";

test("選択中の購読だけを表示し、記事を直接開いても再読み込みしても範囲を維持する", async ({
  context,
  page,
}) => {
  const server = new FakeSendo();
  server.workspacesSupported = true;
  const publicSpace = server.createWorkspace("Public");
  const privateSpace = server.createWorkspace("Personal");
  const privateFolder = server.createFolder("Hidden folder");
  const ordinary = server.subscribe({
    url: "https://public.example/feed",
    title: "Public feed",
    workspaceId: publicSpace.id,
  });
  const personal = server.subscribe({
    url: "https://private.example/feed",
    title: "Hidden feed",
    folderId: privateFolder.id,
    workspaceId: privateSpace.id,
  });
  const sameUrl = "https://example.test/same";
  const publicArticle = server.deliver(ordinary.id, { title: "Public article", url: sameUrl });
  const privateArticle = server.deliver(personal.id, { title: "Hidden article", url: sameUrl });
  server.setArticleState(publicArticle.id, { starred: true });
  server.setArticleState(privateArticle.id, { starred: true });
  await routeFakeSendo(context, server);
  await page.goto("/");
  await signIn(page);

  const list = page.locator(".article-list");
  const nav = page.getByRole("navigation", { name: "Feeds", exact: true });
  const choice = nav.getByRole("button", { name: /^Workspaces:/ });
  const dialog = page.getByRole("dialog", { name: "Workspaces", exact: true });
  const hidePersonal = async () => {
    await choice.click();
    await dialog.getByRole("button", { name: "Only Public", exact: true }).click();
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
  };

  await expect(list.getByText("Public article")).toBeVisible();
  await expect(list.getByText("Hidden article")).toBeVisible();
  await expect(page.getByRole("button", { name: /^Workspaces:/ })).toHaveCount(1);
  await list.getByText("Hidden article").click();
  await expect(page.getByRole("heading", { name: "Hidden article", exact: true })).toBeVisible();
  await hidePersonal();
  await expect(page).not.toHaveURL(/article=/);
  await expect(page.getByRole("heading", { name: "Hidden article" })).toHaveCount(0);
  await expect(list.getByText("Public article")).toBeVisible();
  await expect(list.getByText("Hidden article")).toHaveCount(0);
  await expect(page.locator("nav.sidebar")).not.toContainText(/Hidden feed|Hidden folder/);
  await expect(page).toHaveTitle("(1) All - Sendo");

  await page.goto(`/?article=${privateArticle.id}`);
  await expect(page).not.toHaveURL(/article=/);
  await expect(list.getByText("Hidden article")).toHaveCount(0);
  await page.goto("/search?q=Hidden");
  await expect(list.getByText("Hidden article")).toHaveCount(0);
  await page.goto("/starred");
  await expect(list.getByText("Public article")).toBeVisible();
  await expect(list.getByText("Hidden article")).toHaveCount(0);
  await page.goto("/manage");
  await expect(page.getByRole("main")).toContainText("Public feed");
  await expect(page.getByRole("main")).not.toContainText(/Hidden feed|Hidden folder/);
  await expect(page.getByRole("button", { name: /^Workspaces:/ })).toHaveCount(1);

  await context.route("**/api/v1/**", (route) => route.abort("internetdisconnected"));
  await page.reload();
  await expect(choice).toHaveAccessibleName("Workspaces: Public");
  await expect(page.getByRole("main")).toContainText("Public feed");
  await expect(page.getByRole("main")).not.toContainText("Hidden feed");

  await choice.click();
  await dialog.getByRole("checkbox", { name: "Personal", exact: true }).check();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByRole("main")).toContainText("Hidden feed");
});

test("ワークスペースを All の上から切り替えられ、サイドバーを畳んでも使える", async ({
  context,
  page,
}) => {
  const server = new FakeSendo();
  server.workspacesSupported = true;
  for (const name of ["Public", "Personal"]) {
    const workspace = server.createWorkspace(name);
    const feed = server.subscribe({
      url: `https://${name.toLowerCase()}.example/feed`,
      title: `${name} feed`,
      workspaceId: workspace.id,
    });
    server.deliver(feed.id, { title: `${name} article`, url: null });
  }
  await routeFakeSendo(context, server);
  await page.goto("/");
  await signIn(page);

  const nav = page.getByRole("navigation", { name: "Feeds", exact: true });
  const choice = nav.getByRole("button", { name: /^Workspaces:/ });
  const all = nav.getByRole("link", { name: /^All( \d+)?$/ });
  const dialog = page.getByRole("dialog", { name: "Workspaces", exact: true });
  const list = page.locator(".article-list");
  await expect(choice.getByText("All workspaces", { exact: true })).toBeVisible();
  expect((await choice.boundingBox())?.y).toBeLessThan((await all.boundingBox())?.y ?? 0);
  await nav.getByRole("button", { name: "Collapse sidebar" }).click();
  await expect(choice.getByText("All workspaces", { exact: true })).toBeHidden();
  await choice.click();
  await dialog.getByRole("button", { name: "Only Public", exact: true }).click();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(choice).toHaveAccessibleName("Workspaces: Public");
  await expect(list.getByText("Public article")).toBeVisible();
  await expect(list.getByText("Personal article")).toHaveCount(0);
  await choice.click();
  await dialog.getByRole("button", { name: "All workspaces", exact: true }).click();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(list.getByText("Personal article")).toBeVisible();

  await nav.getByRole("link", { name: "Recently Read", exact: true }).click();
  await choice.click();
  await expect(dialog).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL("/");
  await expect(dialog).toBeHidden();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("button", { name: /^Workspaces:/ })).toBeHidden();
  const menu = page.getByRole("button", { name: "Menu", exact: true });
  await menu.click();
  await expect(choice.getByText("All workspaces", { exact: true })).toBeVisible();
  await nav.getByRole("link", { name: /^Personal feed/ }).click();
  await expect(menu).toHaveAttribute("aria-expanded", "false");
  await list.getByText("Personal article").click();
  await expect(page.getByRole("heading", { name: "Personal article", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Workspaces:/ })).toBeHidden();
  await page.getByRole("button", { name: "More actions", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Article actions", exact: true })
    .getByRole("button", { name: "Open sidebar", exact: true })
    .click();
  await expect(nav).toBeFocused();
  await choice.click();
  await dialog.getByRole("button", { name: "Only Public", exact: true }).click();
  await expect(page).toHaveURL("/");
  await expect(page.locator("nav.sidebar")).toHaveCSS("visibility", "hidden");
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(list.getByText("Public article")).toBeVisible();
  await expect(list.getByText("Personal article")).toHaveCount(0);
});

test("選択を保ったまま新しい空のフォルダへ最初の購読を移せる", async ({ context, page }) => {
  const server = new FakeSendo();
  server.workspacesSupported = true;
  const workspace = server.createWorkspace("Public");
  server.createFolder("Hidden folder");
  server.subscribe({
    url: "https://public.example/feed",
    title: "Public feed",
    workspaceId: workspace.id,
  });
  await routeFakeSendo(context, server);
  await page.goto("/manage");
  await signIn(page);
  await page.getByRole("button", { name: /^Workspaces:/ }).click();
  const picker = page.getByRole("dialog", { name: "Workspaces", exact: true });
  await picker.getByRole("button", { name: "Only Public", exact: true }).click();
  await picker.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: "New folder", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "New folder", exact: true });
  await editor.getByRole("textbox", { name: "Folder name" }).fill("Public folder");
  await editor.getByRole("button", { name: "Create folder", exact: true }).click();
  const destination = page.getByRole("combobox", { name: "Move Public feed to folder" });
  await expect(destination.getByRole("option", { name: "Hidden folder" })).toHaveCount(0);
  await destination.selectOption({ label: "Public folder" });
  await expect(page.getByRole("region", { name: "Public folder", exact: true })).toContainText(
    "Public feed",
  );
});

/** Public と Personal に、それぞれ購読と記事を 1 つずつ置く */
function twoWorkspaces() {
  const server = new FakeSendo();
  server.workspacesSupported = true;
  const spaces: Record<string, ReturnType<FakeSendo["createWorkspace"]>> = {};
  const articles: Record<string, ReturnType<FakeSendo["deliver"]>> = {};
  for (const name of ["Public", "Personal"]) {
    const workspace = server.createWorkspace(name);
    spaces[name] = workspace;
    const feed = server.subscribe({
      url: `https://${name.toLowerCase()}.example/feed`,
      title: `${name} feed`,
      workspaceId: workspace.id,
    });
    articles[name] = server.deliver(feed.id, { title: `${name} article`, url: null });
  }
  return { server, spaces, articles };
}

function workspaceUi(page: Page) {
  const nav = page.getByRole("navigation", { name: "Feeds", exact: true });
  const choice = nav.getByRole("button", { name: /^Workspaces:/ });
  const dialog = page.getByRole("dialog", { name: "Workspaces", exact: true });
  const list = page.locator(".article-list");
  return {
    choice,
    list,
    async choose(action: (dialog: Locator) => Promise<void>) {
      await choice.click();
      await action(dialog);
      await dialog.getByRole("button", { name: "Close", exact: true }).click();
    },
    only: (name: string) => async (d: Locator) => {
      await d.getByRole("button", { name: `Only ${name}`, exact: true }).click();
    },
  };
}

test("新しいタブは最後に選んだ範囲で始まり、開いたあとはタブごとに独立する", async ({
  context,
  page,
}) => {
  const { server } = twoWorkspaces();
  await routeFakeSendo(context, server);
  await page.goto("/");
  await signIn(page);
  const first = workspaceUi(page);
  await expect(first.choice).toHaveAccessibleName("Workspaces: All workspaces");
  await first.choose(first.only("Public"));
  await expect(first.list.getByText("Personal article")).toHaveCount(0);

  const second = await context.newPage();
  await second.goto("/");
  const secondUi = workspaceUi(second);
  await expect(secondUi.choice).toHaveAccessibleName("Workspaces: Public");
  await expect(secondUi.list.getByText("Public article")).toBeVisible();
  await expect(secondUi.list.getByText("Personal article")).toHaveCount(0);
  await expect(second.locator("nav.sidebar")).not.toContainText("Personal feed");

  // 2 つ目のタブで広げても、1 つ目のタブは変わらない（読み込み直しても）
  await secondUi.choose(async (d) => {
    await d.getByRole("checkbox", { name: "Personal", exact: true }).check();
  });
  await expect(secondUi.list.getByText("Personal article")).toBeVisible();
  await page.reload();
  await expect(first.choice).toHaveAccessibleName("Workspaces: Public");
  await expect(first.list.getByText("Public article")).toBeVisible();
  await expect(first.list.getByText("Personal article")).toHaveCount(0);

  // そのあとに開いたタブは、最後に選んだ 2 つ目のタブの範囲で始まる
  const third = await context.newPage();
  await third.goto("/");
  const thirdUi = workspaceUi(third);
  await expect(thirdUi.choice).toHaveAccessibleName(
    /^Workspaces: (Public, Personal|Personal, Public)$/,
  );
  await expect(thirdUi.list.getByText("Personal article")).toBeVisible();
  await expect(thirdUi.list.getByText("Public article")).toBeVisible();

  // オフラインで開いた新しいタブも、手元の一覧で照らして引き継ぐ
  await secondUi.choose(secondUi.only("Public"));
  await context.route("**/api/v1/**", (route) => route.abort("internetdisconnected"));
  const offline = await context.newPage();
  await offline.goto("/");
  const offlineUi = workspaceUi(offline);
  await expect(offlineUi.choice).toHaveAccessibleName("Workspaces: Public");
  await expect(offlineUi.list.getByText("Public article")).toBeVisible();
  await expect(offlineUi.list.getByText("Personal article")).toHaveCount(0);
});

test("最後の選択が All か 0 件選択なら、新しいタブは All で始まる", async ({ context, page }) => {
  const { server } = twoWorkspaces();
  await routeFakeSendo(context, server);
  await page.goto("/");
  await signIn(page);
  const ui = workspaceUi(page);
  const openTab = async () => {
    const tab = await context.newPage();
    await tab.goto("/");
    const tabUi = workspaceUi(tab);
    await expect(tabUi.choice).toHaveAccessibleName("Workspaces: All workspaces");
    await expect(tabUi.list.getByText("Personal article")).toBeVisible();
    await expect(tabUi.list.getByText("Public article")).toBeVisible();
  };

  await ui.choose(ui.only("Public"));
  await ui.choose(async (d) => {
    await d.getByRole("button", { name: "All workspaces", exact: true }).click();
  });
  await openTab();

  await ui.choose(ui.only("Public"));
  await ui.choose(async (d) => {
    await d.getByRole("button", { name: "Clear selection", exact: true }).click();
  });
  // 0 件選択を選んだタブは、空の表示のまま
  await expect(ui.choice).toHaveAccessibleName("Workspaces: No workspace selected");
  await expect(ui.list.getByText("Public article")).toHaveCount(0);
  await openTab();
});

test("覚えたワークスペースがすべて消えていたら All、一部だけなら残ったものだけで始まる", async ({
  context,
  page,
}) => {
  // タブを何度も開き、ワークスペースを 2 度消すので、ほかのテストより長くかかる
  test.setTimeout(60_000);
  const { server, spaces, articles } = twoWorkspaces();
  const empty = server.createWorkspace("Empty");
  const spare = server.createWorkspace("Spare");
  await routeFakeSendo(context, server);
  await page.goto("/manage");
  await signIn(page);
  const manage = page.getByRole("main");
  const deleteWorkspace = async (name: string) => {
    await manage.getByRole("button", { name: "Workspaces", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Workspaces", exact: true });
    await dialog.getByRole("button", { name: `Edit ${name}` }).click();
    await dialog.getByRole("button", { name: "Delete workspace…" }).click();
    await dialog.getByRole("button", { name: "Delete workspace", exact: true }).click();
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
  };
  const ui = workspaceUi(page);

  // 覚えた Empty が、このタブの操作で消える（ほかの端末で消えて同期で届いたのと同じく、手元から消える）
  await ui.choose(ui.only("Empty"));
  await page.goto("/manage");
  await deleteWorkspace("Empty");
  await expect.poll(() => empty.deletedAt).not.toBeNull();
  await page.goto("/");
  await expect(ui.choice).toHaveAccessibleName("Workspaces: No workspace selected");
  // 引き継いだ範囲（Empty）の外の記事を URL で開いても、照らして All になってから決めるので閉じない
  const allTab = await context.newPage();
  await allTab.goto(`/?article=${articles.Personal?.id}`);
  const allUi = workspaceUi(allTab);
  await expect(allUi.choice).toHaveAccessibleName("Workspaces: All workspaces");
  await expect(
    allTab.getByRole("heading", { name: "Personal article", exact: true }),
  ).toBeVisible();
  await expect(allTab).toHaveURL(/article=/);
  // オフラインで開いても、前に揃えた手元の一覧ですぐ照らし、All で始まる
  const offline = (route: Route) => route.abort("internetdisconnected");
  await context.route("**/api/v1/**", offline);
  const offlineTab = await context.newPage();
  await offlineTab.goto("/");
  const offlineUi = workspaceUi(offlineTab);
  await expect(offlineUi.choice).toHaveAccessibleName("Workspaces: All workspaces");
  // Personal article は、上で開いて既読になった
  await expect(offlineUi.list.getByText("Public article")).toBeVisible();
  await offlineTab.close();
  await context.unroute("**/api/v1/**", offline);
  // 照らして All にしたタブは、All をタブの選択として置く。ほかのタブで写しが変わってから読み込み
  // 直しても、写しから引き継ぎ直さない
  await ui.choose(ui.only("Public"));
  await allTab.goto("/");
  await allTab.reload();
  await expect(allUi.choice).toHaveAccessibleName("Workspaces: All workspaces");
  await expect(allUi.list.getByText("Public article")).toBeVisible();

  // Personal と Spare を覚え、Spare だけが消える
  await ui.choose(ui.only("Personal"));
  await ui.choose(async (d) => {
    await d.getByRole("checkbox", { name: "Spare", exact: true }).check();
  });
  await page.goto("/manage");
  await deleteWorkspace("Spare");
  await expect.poll(() => spare.deletedAt).not.toBeNull();
  const partTab = await context.newPage();
  await partTab.goto("/");
  const partUi = workspaceUi(partTab);
  await expect(partUi.choice).toHaveAccessibleName("Workspaces: Personal");
  await expect(partTab.locator("nav.sidebar")).toContainText("Personal feed");
  await expect(partUi.list.getByText("Public article")).toHaveCount(0);
  expect(spaces.Personal?.deletedAt).toBeNull();
});

test("写しが読めなければ、新しいタブは All で始まる", async ({ context, page }) => {
  const { server } = twoWorkspaces();
  await routeFakeSendo(context, server);
  await page.goto("/");
  await signIn(page);
  const ui = workspaceUi(page);
  await ui.choose(ui.only("Public"));
  await page.evaluate(() => {
    const key = Object.keys(localStorage).find((k) =>
      k.startsWith("sendo.workspace-selection-last."),
    );
    if (key === undefined) throw new Error("写しがない");
    localStorage.setItem(key, "{");
  });
  const tab = await context.newPage();
  await tab.goto("/");
  await expect(workspaceUi(tab).choice).toHaveAccessibleName("Workspaces: All workspaces");
});

test("ログアウトとユーザーの切り替えで、最後の選択の写しを消す", async ({ context, page }) => {
  const { server } = twoWorkspaces();
  await routeFakeSendo(context, server);
  await page.goto("/");
  await signIn(page);
  const ui = workspaceUi(page);
  const copies = () =>
    page.evaluate(() =>
      Object.keys(localStorage).filter((k) => k.startsWith("sendo.workspace-selection-last.")),
    );
  await ui.choose(ui.only("Public"));
  expect(await copies()).toHaveLength(1);

  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByRole("button", { name: "Google でログイン" })).toBeVisible();
  await expect.poll(copies).toEqual([]);
  await signIn(page);
  // このタブは、タブ自身の選択を使う。新しいタブは、写しが消えているので All で始まる
  await expect(ui.choice).toHaveAccessibleName("Workspaces: Public");
  const tab = await context.newPage();
  await tab.goto("/");
  await expect(workspaceUi(tab).choice).toHaveAccessibleName("Workspaces: All workspaces");
  await tab.close();

  // 別のタブなどで、別のアカウントでログインし直した（ブラウザーのクッキーが替わった）
  await ui.choose(ui.only("Public"));
  expect(await copies()).toHaveLength(1);
  await context.addCookies([
    {
      name: "__Host-sendo_session",
      value: server.createSession({ id: "user-b", email: "b@example.com" }),
      url: "https://localhost/",
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  await page.getByRole("button", { name: "Sync now", exact: true }).click();
  await expect.poll(copies).toEqual([]);
});
