import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { VercelSettingsPanel } from "@/components/vercel-settings-panel";

describe("VercelSettingsPanel", () => {
  it("shows a real next action and working destinations for a partially configured workspace", () => {
    const html = renderToStaticMarkup(createElement(VercelSettingsPanel, {
      actor: {
        userId: "user-1",
        workspaceId: "workspace-1",
        role: "owner",
        email: "owner@example.com",
        displayName: "Northstar",
      },
      blobReady: false,
      aiReady: false,
      cronReady: false,
    }));

    expect(html).toContain("Allt viktigt. På ett ställe.");
    expect(html).toContain("Gör klart Privat Blob-media.");
    expect(html).toContain("https://vercel.com/docs/vercel-blob/using-blob-sdk");
    expect(html).toContain("/studio/engine");
    expect(html).toContain("/studio/automations");
    expect(html).toContain("/studio/channels");
    expect(html).toContain("Hemligheter visas aldrig här.");
  });
});
