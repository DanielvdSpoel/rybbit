"use client";
import { useWindowSize } from "@uidotdev/usehooks";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import { AppSidebar } from "../../components/AppSidebar";
import { useStore } from "../../lib/store";
import { useSyncStateWithUrl } from "../../lib/urlParams";
import { Footer } from "../components/Footer";
import { Header } from "./components/Header/Header";
import { Sidebar } from "./components/Sidebar/Sidebar";
import { useEmbedPageOptions } from "./utils";

const PRIVATE_KEY_PATTERN = /^[a-f0-9]{12}$/i;

function getMainDashboardPath(pathname: string) {
  const segments = pathname.split("/").filter(Boolean);
  const siteId = segments[0];
  if (!siteId || isNaN(Number(siteId))) return null;

  const hasPrivateKey = segments.length > 1 && PRIVATE_KEY_PATTERN.test(segments[1]);
  return hasPrivateKey ? `/${siteId}/${segments[1]}/main` : `/${siteId}/main`;
}

function isMainDashboardPath(pathname: string) {
  const segments = pathname.split("/").filter(Boolean);
  const hasPrivateKey = segments.length > 1 && PRIVATE_KEY_PATTERN.test(segments[1]);
  const route = hasPrivateKey ? segments[2] : segments[1];
  return route === "main";
}

export default function SiteLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { setSite, site, setPrivateKey } = useStore();
  const { hideSidebar } = useEmbedPageOptions();

  // Sync store state with URL parameters
  useSyncStateWithUrl();

  useEffect(() => {
    const segments = pathname.split("/").filter(Boolean);

    if (segments.length > 0) {
      const siteId = segments[0];

      // Update site if it's different and is a number
      if (siteId !== site && !isNaN(Number(siteId))) {
        setSite(siteId);
      }

      // Check if second segment is a private key (12 hex chars)
      if (segments.length > 1 && /^[a-f0-9]{12}$/i.test(segments[1])) {
        setPrivateKey(segments[1]);
      } else {
        setPrivateKey(null);
      }
    }
  }, [pathname]);

  useEffect(() => {
    if (!hideSidebar || isMainDashboardPath(pathname)) return;

    const mainPath = getMainDashboardPath(pathname);
    if (!mainPath) return;

    router.replace(`${mainPath}${window.location.search}`);
  }, [hideSidebar, pathname, router]);

  const { width } = useWindowSize();

  if (width && width < 768) {
    return (
      <div>
        <Header />
        <div>{children}</div>
      </div>
    );
  }

  return (
    <div className="flex flex-row h-dvh">
      <AppSidebar />
      <div className="flex flex-1 overflow-hidden">
        {!hideSidebar && (
          <div className="hidden md:flex">
            <Sidebar />
          </div>
        )}
        <div className="flex-1 overflow-auto">
          <div className="min-h-full flex flex-col">
            {/* <div className="px-4 py-2 max-w-[1400px] mx-auto w-full mb-4"> */}
            <Header />
            <div className="flex-1">{children}</div>
            {!pathname.includes("/map") &&
              !pathname.includes("/realtime") &&
              !pathname.includes("/replay") &&
              !pathname.includes("/globe") &&
              !pathname.includes("/api-playground") && <Footer />}
          </div>
        </div>
      </div>
    </div>
  );
}
