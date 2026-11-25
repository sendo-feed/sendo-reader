import { expect, test } from "@playwright/test";
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
