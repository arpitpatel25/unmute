import { test, expect } from "@playwright/test";
const routes = [
  "/",
  "/dictation.html",
  "/remote.html",
  "/pricing.html",
  "/manifesto.html",
  "/privacy.html",
  "/terms.html",
  "/refund.html",
  "/try.html",
];
for (const route of routes)
  test(`renders ${route} without overflow, missing assets or metadata`, async ({
    page,
  }) => {
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("response", (r) => {
      if (r.url().startsWith("http://localhost:4173") && r.status() >= 400)
        errors.push(`${r.status()} ${r.url()}`);
    });
    await page.goto(route);
    await expect(page.locator("h1")).toHaveCount(1);
    await expect(page.locator("main")).toHaveCount(1);
    await expect(page.locator("meta[name=description]")).toHaveAttribute(
      "content",
      /.{40,}/,
    );
    await expect(page.locator("link[rel=canonical]")).toHaveAttribute(
      "href",
      /^https:\/\/justunmute.me\//,
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    expect(
      await page
        .locator("img")
        .evaluateAll((imgs) =>
          imgs.every((i) => i.complete && i.naturalWidth > 0),
        ),
    ).toBe(true);
    expect(errors).toEqual([]);
  });
test("task preview can open overview, show activity, accept a reply and reset", async ({
  page,
}) => {
  await page.goto("/");
  const d = page.locator("[data-product-demo]");
  await d.getByRole("button", { name: "Open session overview" }).click();
  await expect(d.getByText("Whose move is it?")).toBeVisible();
  await d.getByRole("button", { name: "Website design review" }).click();
  await d.getByRole("button", { name: "Show activity" }).click();
  await expect(d.locator(".terminal")).toBeVisible();
  await d.getByRole("button", { name: "Try this task", exact: true }).click();
  await expect(
    d.getByRole("heading", { name: "One decision needs you." }),
  ).toBeVisible();
  await d
    .getByRole("textbox", { name: "Reply to the example agent" })
    .fill("Keep the type spacious");
  await d.getByRole("button", { name: "Reply", exact: true }).click();
  await expect(
    d.getByText("Your reply: “Keep the type spacious”"),
  ).toBeVisible();
  await d.getByRole("button", { name: "Reset product preview" }).click();
  await expect(
    d.getByRole("button", { name: "Try this task", exact: true }),
  ).toBeVisible();
});
test("all five modes produce their own output; formatting is reversible", async ({
  page,
}) => {
  await page.goto("/");
  const d = page.locator("[data-product-demo]");
  for (const [tab, action, output] of [
    ["Dictation", "Try dictation", "Your thought, delivered."],
    ["Scratchpad", "Collect a thought", "Everything in one place."],
    ["Meetings", "Preview meeting notes", "Notes you can act on."],
    ["Memory", "Ask Unmute", "Here’s where you left it."],
  ]) {
    await d.getByRole("tab", { name: tab, exact: true }).click();
    await d.getByRole("button", { name: action, exact: true }).click();
    await expect(
      d.getByRole("heading", { name: output, exact: true }),
    ).toBeVisible();
    if (tab === "Dictation") {
      await d.getByRole("button", { name: "Make it three bullets" }).click();
      await expect(d.locator(".window-content li")).toHaveCount(3);
      await d.getByRole("button", { name: "Show original" }).click();
      await expect(
        d.getByRole("textbox", { name: "Example dictation" }),
      ).toBeVisible();
    }
  }
});
test("annual prices show annual totals and FAQ expands", async ({ page }) => {
  await page.goto("/pricing.html");
  await page.getByRole("button", { name: "Yearly", exact: true }).click();
  await expect(page.locator('[data-plan-price="dictation"]')).toHaveText(
    "$49 / year",
  );
  await expect(page.locator('[data-plan-price="unmute"]')).toHaveText(
    "$79 / year",
  );
  await page.getByRole("button", { name: "Monthly", exact: true }).click();
  await expect(page.locator('[data-plan-price="unmute"]')).toHaveText(
    "$7.99 / month",
  );
  await page.getByText("Are agent costs included?", { exact: true }).click();
  await expect(page.locator("details[open]")).toHaveCount(1);
});
test("tab keyboard navigation and reduced motion work", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await page.getByRole("tab", { name: "Unmute Remote", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(
    page.getByRole("tab", { name: "Dictation", exact: true }),
  ).toBeFocused();
  await expect(
    page.getByRole("tab", { name: "Dictation", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await page
    .getByRole("button", { name: "Try dictation", exact: true })
    .click();
  expect(
    await page
      .locator(".wave i")
      .first()
      .evaluate((e) => getComputedStyle(e).animationName),
  ).toBe("none");
});
test("reset clears formatting and keyboard reply keeps focus inside the task", async ({
  page,
}) => {
  await page.goto("/");
  const d = page.locator("[data-product-demo]");
  await d.getByRole("tab", { name: "Dictation", exact: true }).click();
  await d.getByRole("button", { name: "Try dictation", exact: true }).click();
  await d.getByRole("button", { name: "Make it three bullets" }).click();
  await d.getByRole("button", { name: "Reset product preview" }).click();
  await d.getByRole("button", { name: "Try dictation", exact: true }).click();
  await expect(
    d.getByRole("button", { name: "Make it three bullets" }),
  ).toBeVisible();
  await d.getByRole("tab", { name: "Unmute Remote", exact: true }).click();
  await d.getByRole("button", { name: "Try this task", exact: true }).click();
  const reply = d.getByRole("textbox", { name: "Reply to the example agent" });
  await reply.fill("Keep it simple");
  await reply.press("Enter");
  await expect(
    d.getByRole("button", { name: "Try again", exact: true }),
  ).toBeFocused();
});
test("reply drafts survive overview and reset clears them", async ({
  page,
}) => {
  await page.goto("/");
  const d = page.locator("[data-product-demo]");
  await d.getByRole("button", { name: "Try this task", exact: true }).click();
  await d
    .getByRole("textbox", { name: "Reply to the example agent" })
    .fill("Preserve this draft");
  await d.getByRole("button", { name: "Open session overview" }).click();
  await d.getByRole("button", { name: "Close overview" }).click();
  await expect(
    d.getByRole("textbox", { name: "Reply to the example agent" }),
  ).toHaveValue("Preserve this draft");
  await d.getByRole("button", { name: "Reset product preview" }).click();
  await d.getByRole("button", { name: "Try this task", exact: true }).click();
  await expect(
    d.getByRole("textbox", { name: "Reply to the example agent" }),
  ).toHaveValue("");
});
test("mobile menu can be opened, dismissed, and used", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "Mobile navigation");
  await page.goto("/");
  const menu = page.getByRole("button", { name: "Menu", exact: true });
  await menu.click();
  await expect(menu).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Escape");
  await expect(menu).toHaveAttribute("aria-expanded", "false");
  await expect(menu).toBeFocused();
  await menu.click();
  await page
    .locator("#navigation")
    .getByRole("link", { name: "Pricing", exact: true })
    .click();
  await expect(page).toHaveURL(/pricing.html/);
});
test("guided trial has no microphone prompt or service calls", async ({
  page,
}) => {
  const external = [];
  page.on("request", (r) => {
    if (!r.url().startsWith("http://localhost:4173")) external.push(r.url());
  });
  await page.goto("/try.html");
  await page
    .getByRole("button", { name: "Try dictation", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Your thought, delivered." }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Enable microphone" }),
  ).toHaveCount(0);
  expect(external).toEqual([]);
});
test("Notch collapses and expands without losing the selected agent", async ({
  page,
}) => {
  await page.goto("/");
  const d = page.locator("[data-product-demo]");
  await d.getByRole("button", { name: "Switch example agent" }).click();
  await expect(
    d.getByRole("button", { name: "Switch example agent" }),
  ).toContainText("Codex");
  await d.getByRole("button", { name: "Collapse Notch" }).click();
  await expect(d.locator(".notch")).toHaveClass(/collapsed/);
  await d.getByRole("button", { name: "Expand Notch" }).click();
  await expect(
    d.getByRole("button", { name: "Switch example agent" }),
  ).toContainText("Codex");
  await expect(
    d.getByRole("button", { name: "Try this task", exact: true }),
  ).toBeVisible();
});
