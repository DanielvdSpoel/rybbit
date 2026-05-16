"use client";

import { useQueryState, parseAsBoolean } from "nuqs";
import { useCurrentSite } from "../../api/admin/hooks/useSites";

export const useEmbedPageOptions = () => {
  const [embed] = useQueryState("embed", parseAsBoolean);
  const [hideSidebar] = useQueryState("hideSidebar", parseAsBoolean);

  const { subscription } = useCurrentSite();

  const isEmbedPage = !!embed && subscription?.planName !== "free";

  return {
    embed: isEmbedPage,
    hideSidebar: isEmbedPage && !!hideSidebar,
  };
};

export const useEmbedablePage = () => {
  return useEmbedPageOptions().embed;
};
