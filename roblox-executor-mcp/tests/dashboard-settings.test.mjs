import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_DASHBOARD_SETTINGS,
  normalizeDashboardSettings,
} from "../dist/dashboard/settings.js";

test("dashboard settings normalize complete custom themes", () => {
  const settings = normalizeDashboardSettings({
    version: 1,
    theme: "custom",
    colors: {
      background: "#FAFAFA",
      surface: "#ffffff",
      raised: "#f1f1f1",
      border: "#d0d0d0",
      accent: "#C15F3C",
      text: "#202020",
      muted: "#6b6b6b",
    },
    fonts: {
      sans: "source-sans",
      mono: "jetbrains-mono",
      customSans: "",
      customMono: "",
    },
    backgroundMedia: {
      type: "video",
      url: "https://example.com/background.mp4",
      fit: "cover",
      opacity: 0.4,
    },
  });

  assert.equal(settings.theme, "custom");
  assert.equal(settings.colors.background, "#fafafa");
  assert.equal(settings.colors.accent, "#c15f3c");
  assert.equal(settings.fonts.sans, "source-sans");
  assert.equal(settings.fonts.mono, "jetbrains-mono");
  assert.equal(settings.backgroundMedia.type, "video");
  assert.equal(settings.backgroundMedia.url, "https://example.com/background.mp4");
  assert.equal(settings.backgroundMedia.opacity, 0.4);
});

test("dashboard settings reject unsupported values without damaging valid fields", () => {
  const settings = normalizeDashboardSettings({
    theme: "unknown-theme",
    colors: { background: "url(https://example.invalid)", accent: "#10a37f" },
    fonts: { sans: "unknown-font", mono: "ibm-plex-mono", customSans: "bad; font" },
    backgroundMedia: { type: "iframe", url: "javascript:alert(1)", opacity: 99 },
  });

  assert.equal(settings.theme, DEFAULT_DASHBOARD_SETTINGS.theme);
  assert.equal(settings.colors.background, DEFAULT_DASHBOARD_SETTINGS.colors.background);
  assert.equal(settings.colors.accent, "#10a37f");
  assert.equal(settings.fonts.sans, DEFAULT_DASHBOARD_SETTINGS.fonts.sans);
  assert.equal(settings.fonts.mono, "ibm-plex-mono");
  assert.equal(settings.fonts.customSans, DEFAULT_DASHBOARD_SETTINGS.fonts.customSans);
  assert.equal(settings.backgroundMedia.type, DEFAULT_DASHBOARD_SETTINGS.backgroundMedia.type);
  assert.equal(settings.backgroundMedia.url, DEFAULT_DASHBOARD_SETTINGS.backgroundMedia.url);
  assert.equal(settings.backgroundMedia.opacity, 1);
});
