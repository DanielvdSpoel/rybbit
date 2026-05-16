"use client";

import { useExtracted } from "next-intl";
import { useState } from "react";

import { SiteResponse } from "@/api/admin/endpoints";
import { CodeSnippet } from "@/components/CodeSnippet";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

interface DashboardEmbedTabProps {
  siteMetadata: SiteResponse;
  sitePublic: boolean;
  disabled?: boolean;
  togglingPublic: boolean;
  onTogglePublic: (checked: boolean) => void;
}

const DASHBOARD_PREVIEW_WIDTH = 1920;
const DASHBOARD_PREVIEW_HEIGHT = 1080;
const DASHBOARD_PREVIEW_SCALE = 0.3;

export function DashboardEmbedTab({
  siteMetadata,
  sitePublic,
  disabled = false,
  togglingPublic,
  onTogglePublic,
}: DashboardEmbedTabProps) {
  const t = useExtracted();
  const [hideDashboardSidebar, setHideDashboardSidebar] = useState(true);

  const siteId = siteMetadata.siteId;
  const origin = typeof window !== "undefined" ? window.location.origin : "";

  const dashboardUrl = new URL(`${origin}/${siteId}/main`);
  dashboardUrl.searchParams.set("embed", "true");
  if (hideDashboardSidebar) {
    dashboardUrl.searchParams.set("hideSidebar", "true");
  }

  const dashboardPreviewWidth = DASHBOARD_PREVIEW_WIDTH * DASHBOARD_PREVIEW_SCALE;
  const dashboardPreviewHeight = DASHBOARD_PREVIEW_HEIGHT * DASHBOARD_PREVIEW_SCALE;

  const dashboardIframeCode = `<iframe
  src="${dashboardUrl.toString()}"
  style="border: 0; width: 100%; height: 720px;"
  loading="lazy"
  title="Analytics dashboard"
></iframe>`;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <Label htmlFor="dashboard-public" className="text-sm font-medium text-foreground">
            {t("Public Analytics")}
          </Label>
          <p className="text-xs text-muted-foreground mt-1">
            {t("Anyone can view your site analytics without logging in")}
          </p>
        </div>
        <Switch
          id="dashboard-public"
          checked={sitePublic}
          disabled={disabled || togglingPublic}
          onCheckedChange={onTogglePublic}
        />
      </div>

      <section className="space-y-4">
        <div>
          <h5 className="text-xs font-semibold text-foreground uppercase tracking-wide">{t("Public Dashboard")}</h5>
          <p className="text-xs text-muted-foreground mt-1">
            {t("Embed the public main analytics dashboard on another site.")}
          </p>
        </div>

        <fieldset
          disabled={!sitePublic}
          className={`space-y-4 transition-opacity ${!sitePublic ? "opacity-50 pointer-events-none select-none" : ""}`}
          aria-disabled={!sitePublic}
        >
          <div className="flex items-center justify-between gap-4">
            <div>
              <Label htmlFor="dashboard-hide-sidebar" className="text-sm font-medium text-foreground">
                {t("Hide sidebar")}
              </Label>
              <p className="text-xs text-muted-foreground mt-1">
                {t("Only the main dashboard page can be viewed from this embed.")}
              </p>
            </div>
            <Switch
              id="dashboard-hide-sidebar"
              checked={hideDashboardSidebar}
              onCheckedChange={setHideDashboardSidebar}
            />
          </div>
        </fieldset>

        <div className="space-y-2">
          <h5 className="text-xs font-semibold text-foreground uppercase tracking-wide">{t("Preview")}</h5>
          <div className="rounded-md border border-neutral-200 dark:border-neutral-800 p-2 bg-neutral-100 dark:bg-neutral-950">
            {sitePublic ? (
              <div
                className="mx-auto overflow-hidden rounded-sm bg-white dark:bg-neutral-950"
                style={{
                  width: dashboardPreviewWidth,
                  maxWidth: "100%",
                  height: dashboardPreviewHeight,
                }}
              >
                <iframe
                  key={dashboardUrl.toString()}
                  src={dashboardUrl.toString()}
                  width={DASHBOARD_PREVIEW_WIDTH}
                  height={DASHBOARD_PREVIEW_HEIGHT}
                  style={{
                    border: 0,
                    width: DASHBOARD_PREVIEW_WIDTH,
                    height: DASHBOARD_PREVIEW_HEIGHT,
                    transform: `scale(${DASHBOARD_PREVIEW_SCALE})`,
                    transformOrigin: "top left",
                  }}
                  title="Dashboard preview"
                />
              </div>
            ) : (
              <div className="h-[220px] rounded-md border border-dashed border-neutral-300 dark:border-neutral-700 flex items-center justify-center text-xs text-muted-foreground">
                {t("Make this site public to preview")}
              </div>
            )}
          </div>
        </div>

        <div className="space-y-2">
          <h5 className="text-xs font-semibold text-foreground uppercase tracking-wide">{t("Embed Code")}</h5>
          <CodeSnippet language="HTML" code={dashboardIframeCode} />
        </div>
      </section>
    </div>
  );
}
