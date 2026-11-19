import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import type { DiscordIntegration } from "@sendo-reader/core";
import { FakeSendo, routeFakeSendo, signIn } from "./fake-sendo";

const api = "/api/v1/integrations/discord";
const inviteUrl = "https://discord.com/oauth2/authorize?scope=bot";
const authorizationUrl = "https://discord.com/oauth2/authorize?scope=identify";
const channelUrl = "https://discord.com/channels/111/222";
const secondChannelUrl = "https://discord.com/channels/111/333";
const unreadableUrl = "https://discord.com/channels/111/444";

async function setup(context: BrowserContext, initial: Partial<DiscordIntegration> = {}) {
  const server = new FakeSendo();
  const integration: DiscordIntegration = {
    available: true,
    connected: false,
    inviteUrl,
    subscriptions: [],
    ...initial,
  };
  const requests: string[] = [];

  function removePosts(feedId: string) {
    for (const article of server.inbox.values()) {
      if (article.feedId === feedId) server.removeFromInbox(article.id);
    }
  }

  server.onRequest = async (path) => {
    const index = integration.subscriptions.findIndex(
      ({ feedId }) => path === `DELETE /feeds/${feedId}`,
    );
    if (index < 0) return;
    const removed = integration.subscriptions.splice(index, 1);
    for (const { feedId } of removed) removePosts(feedId);
    requests.push(path);
  };

  await routeFakeSendo(context, server);
  await context.route(/\/api\/v1\/integrations\/discord(?:\/[^?]+)?(?:\?.*)?$/, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = `${request.method()} ${url.pathname}`;
    expect(await request.headerValue("authorization")).toBeNull();
    expect(await request.headerValue("cookie")).toContain("__Host-sendo_session=");
    requests.push(path);
    switch (path) {
      case `GET ${api}`:
        return route.fulfill({ json: integration });
      case `POST ${api}/connect`:
        if (!integration.available) {
          return route.fulfill({
            status: 501,
            json: { error: { code: "feature_unavailable", message: "Discord is not configured" } },
          });
        }
        expect(request.postDataJSON()).toEqual({ returnTo: "/settings" });
        return route.fulfill({ json: { authorizationUrl } });
      case `GET ${api}/callback`:
        integration.connected = true;
        return route.fulfill({ status: 302, headers: { location: "/settings?discord=connected" } });
      case `POST ${api}/subscriptions`: {
        const { url } = request.postDataJSON() as { url: string };
        if (url === unreadableUrl) {
          return route.fulfill({
            status: 404,
            json: { error: { code: "channel_not_found", message: "channel is not readable" } },
          });
        }
        expect([channelUrl, secondChannelUrl]).toContain(url);
        const name = url === channelUrl ? "announcements" : "general";
        const feed = server.subscribe({ url, title: name });
        feed.siteUrl = url;
        const post = server.deliver(feed.id, { title: `Discord: ${name}` });
        server.setArticleState(post.id, { starred: true });
        const subscription = { feedId: feed.id, url, name };
        integration.subscriptions.push(subscription);
        return route.fulfill({ status: 201, json: subscription });
      }
      case `DELETE ${api}`:
        for (const { feedId } of integration.subscriptions) {
          removePosts(feedId);
          server.unsubscribe(feedId);
        }
        integration.subscriptions = [];
        integration.connected = false;
        return route.fulfill({ status: 204 });
      default:
        return route.abort();
    }
  });
  return { integration, requests };
}

const integrationsTab = (page: Page) =>
  page.getByRole("tab", { name: "Integrations", exact: true });

async function openIntegrations(page: Page) {
  await page.goto("/settings");
  await signIn(page);
  await integrationsTab(page).click();
}

test("Discord の認可画面へ移り、戻ったら接続結果と最新の状態を出す", async ({ page, context }) => {
  const { requests } = await setup(context);
  await context.route(authorizationUrl, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<a href="${new URL(`${api}/callback?code=example`, page.url()).href}">Authorize</a>`,
    }),
  );
  await openIntegrations(page);
  await expect(page.getByText(/Discord サーバーの管理者が/)).toBeVisible();
  await expect(page.getByRole("link", { name: "Invite bot" })).toHaveAttribute("href", inviteUrl);
  await page.getByRole("button", { name: "Connect Discord", exact: true }).click();
  await expect(page).toHaveURL(authorizationUrl);
  await page.getByRole("link", { name: "Authorize" }).click();
  await expect(page.getByText("Discord を接続しました。")).toBeVisible();
  await expect(page.getByLabel("Channel URL")).toBeVisible();
  await expect(integrationsTab(page)).toHaveAttribute("aria-selected", "true");
  await expect(page).toHaveURL(/\/settings$/);
  expect(requests).toEqual([
    `GET ${api}`,
    `POST ${api}/connect`,
    `GET ${api}/callback`,
    `GET ${api}`,
  ]);
  await page.reload();
  await expect(page.getByText("Discord を接続しました。")).toHaveCount(0);
});

test("Discord の認可を取り消した場合や state が無効な場合も設定に結果を出す", async ({
  page,
  context,
}) => {
  const { requests } = await setup(context);
  await page.goto("/settings?discord=access_denied");
  await signIn(page);
  await expect(page.getByText("Discord の接続をキャンセルしました。")).toBeVisible();
  await expect(page.getByRole("button", { name: "Connect Discord", exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/settings$/);
  await page.goto("/?discord=invalid_state");
  await expect(
    page.getByText("Discord の接続を続けられませんでした。もう一度接続してください。"),
  ).toBeVisible();
  await expect(integrationsTab(page)).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("button", { name: "Connect Discord", exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/settings$/);
  expect(requests).toEqual([`GET ${api}`, `GET ${api}`]);
});

test("チャンネルを購読・解除し、Discord の連携解除も差分同期でスター付きの投稿に反映する", async ({
  page,
  context,
}) => {
  const { requests, integration } = await setup(context, { connected: true });
  await openIntegrations(page);

  const input = page.getByLabel("Channel URL");
  const subscribe = page.getByRole("button", { name: "Subscribe", exact: true });
  await input.fill(unreadableUrl);
  await subscribe.click();
  await expect(page.getByRole("alert")).toContainText("チャンネルを読めません。");
  await expect(input).toHaveValue(unreadableUrl);

  await input.fill(channelUrl);
  await subscribe.click();
  await expect(page.getByRole("link", { name: "announcements", exact: true })).toHaveAttribute(
    "href",
    channelUrl,
  );
  await input.fill(secondChannelUrl);
  await subscribe.click();
  await expect(page.getByRole("link", { name: "general", exact: true })).toBeVisible();

  const saved = page.getByRole("link", { name: "Saved", exact: true });
  await saved.click();
  await expect(page.getByText("Discord: announcements", { exact: true })).toBeVisible();
  await expect(page.getByText("Discord: general", { exact: true })).toBeVisible();

  await page.goto("/manage");
  await page.getByRole("button", { name: "Feed options: announcements" }).click();
  const feedOptions = page.getByRole("dialog", { name: "announcements" });
  await feedOptions.getByRole("button", { name: "Unsubscribe…" }).click();
  await expect(feedOptions).toContainText("スター付きも含めて削除されます");
  await feedOptions.getByRole("button", { name: "Close" }).click();
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await integrationsTab(page).click();

  const remove = page
    .getByRole("listitem")
    .filter({ hasText: "announcements" })
    .getByRole("button", { name: "Unsubscribe…" });
  await remove.click();
  const unsubscribe = page.getByRole("dialog", { name: "Unsubscribe" });
  await expect(unsubscribe).toContainText("スター付きも含めて削除されます");
  await unsubscribe.getByRole("button", { name: "Cancel" }).click();
  expect(requests.filter((path) => path.startsWith("DELETE"))).toEqual([]);
  await remove.click();
  await unsubscribe.getByRole("button", { name: "Unsubscribe", exact: true }).click();
  await expect(page.getByText("チャンネルの購読を解除しました。")).toBeVisible();
  await expect(page.getByRole("link", { name: "announcements", exact: true })).toHaveCount(0);

  await saved.click();
  await expect(page.getByText("Discord: announcements", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Discord: general", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await integrationsTab(page).click();

  await page.getByRole("button", { name: "Disconnect Discord…" }).click();
  const disconnect = page.getByRole("dialog", { name: "Disconnect Discord" });
  await expect(disconnect).toContainText("すべての Discord チャンネルの購読が解除され");
  await expect(disconnect).toContainText("スター付きも含めて削除されます");
  await disconnect.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(page.getByText("Discord の連携を解除しました。")).toBeVisible();
  await expect(page.getByRole("button", { name: "Connect Discord", exact: true })).toBeVisible();
  await saved.click();
  await expect(page.getByText("Discord: general", { exact: true })).toHaveCount(0);
  expect(integration.subscriptions).toHaveLength(0);
  expect(requests.filter((path) => path.startsWith("DELETE"))).toEqual([
    expect.stringMatching(/^DELETE \/feeds\//),
    `DELETE ${api}`,
  ]);
});

test("Discord 連携が利用できなくなったら理由を出し、操作を出さない", async ({ page, context }) => {
  const { integration } = await setup(context);
  await openIntegrations(page);
  const connect = page.getByRole("button", { name: "Connect Discord", exact: true });
  await expect(connect).toBeVisible();
  integration.available = false;
  integration.inviteUrl = null;
  await connect.click();
  await expect(page.getByRole("alert")).toContainText(
    "Discord 連携の設定がないため、利用できません",
  );
  await expect(connect).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Invite bot" })).toHaveCount(0);

  await page.reload();
  await integrationsTab(page).click();
  await expect(
    page.getByText("Sendo サーバーに Discord 連携の設定がないため、利用できません。"),
  ).toBeVisible();
  await expect(connect).toHaveCount(0);
  await expect(page.getByLabel("Channel URL")).toHaveCount(0);
});
