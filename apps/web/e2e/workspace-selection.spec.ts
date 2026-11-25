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
  const choice = page.getByRole("button", { name: /^Workspaces:/ });
  const dialog = page.getByRole("dialog", { name: "Workspaces", exact: true });
  const hidePersonal = async () => {
    await choice.click();
    await dialog.getByRole("button", { name: "Only Public", exact: true }).click();
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
  };

  await expect(list.getByText("Public article")).toBeVisible();
  await expect(list.getByText("Hidden article")).toBeVisible();
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
