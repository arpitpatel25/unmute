import { prices } from "./product-model.js";
const toggle = document.querySelector(".menu-toggle"),
  nav = document.querySelector(".nav-links");
toggle?.addEventListener("click", () => {
  const open = toggle.getAttribute("aria-expanded") !== "true";
  toggle.setAttribute("aria-expanded", String(open));
  nav.classList.toggle("open", open);
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && nav?.classList.contains("open")) {
    nav.classList.remove("open");
    toggle.setAttribute("aria-expanded", "false");
    toggle.focus();
  }
});
nav?.addEventListener("click", (e) => {
  if (e.target.closest("a")) {
    nav.classList.remove("open");
    toggle.setAttribute("aria-expanded", "false");
  }
});
for (const button of document.querySelectorAll("[data-billing]"))
  button.addEventListener("click", () => {
    const interval = button.dataset.billing;
    document
      .querySelectorAll("[data-billing]")
      .forEach((b) => b.setAttribute("aria-pressed", String(b === button)));
    document.querySelectorAll("[data-plan-price]").forEach((el) => {
      el.innerHTML = `$${interval === "month" ? prices[el.dataset.planPrice].month.toFixed(2) : prices[el.dataset.planPrice].year}<span> / ${interval === "month" ? "month" : "year"}</span>`;
    });
    document.querySelectorAll("[data-billing-note]").forEach((el) => {
      el.textContent =
        interval === "month"
          ? "Billed monthly. Cancel anytime."
          : "One payment per year. Cancel renewal anytime.";
    });
  });
